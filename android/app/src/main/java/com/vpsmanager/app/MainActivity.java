package com.vpsmanager.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.EditText;

import com.jcraft.jsch.ChannelExec;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the shared web UI (assets: index.html + core.js) in a WebView and gives it
 * a small native bridge: HTTP calls, SSH, key/value storage, clipboard and share.
 */
public class MainActivity extends Activity {
    private static final String API_PREFIX = "https://www.mehranhost.cloud/api/v1/";
    private static final int REQ_FILE = 1;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);

        webView.addJavascriptInterface(new Bridge(), "Native");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsAlert(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.confirm()).show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel()).show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView v, String url, String message, String def, final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(def == null ? "" : def);
                new AlertDialog.Builder(MainActivity.this).setMessage(message).setView(input)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm(input.getText().toString()))
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel()).show();
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView w, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try {
                    startActivityForResult(Intent.createChooser(i, "Select key file"), REQ_FILE);
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && filePathCallback != null) {
            Uri[] r = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                r = new Uri[]{data.getData()};
            }
            filePathCallback.onReceiveValue(r);
            filePathCallback = null;
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    private void reply(String id, String json) {
        final String js = "window.__cb(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")";
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private static String readAll(InputStream is) throws java.io.IOException {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String errorJson(Exception e) {
        try {
            return new JSONObject().put("error", String.valueOf(e.getMessage())).toString();
        } catch (JSONException x) {
            return "{\"error\":\"error\"}";
        }
    }

    /** Methods callable from JavaScript as window.Native.*  */
    public class Bridge {
        private SharedPreferences prefs() {
            return getSharedPreferences("vpsm", Context.MODE_PRIVATE);
        }

        @JavascriptInterface
        public String get(String key) {
            return prefs().getString(key, "");
        }

        @JavascriptInterface
        public void put(String key, String value) {
            prefs().edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public void copy(String text) {
            ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            cm.setPrimaryClip(ClipData.newPlainText("vps", text));
        }

        @JavascriptInterface
        public void share(String name, String text) {
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType("text/plain");
            i.putExtra(Intent.EXTRA_SUBJECT, name);
            i.putExtra(Intent.EXTRA_TEXT, text);
            startActivity(Intent.createChooser(i, name));
        }

        @JavascriptInterface
        public void http(final String id, final String method, final String url,
                         final String headersJson, final String body) {
            pool.execute(() -> {
                String result;
                try {
                    if (!url.startsWith(API_PREFIX)) throw new Exception("URL not allowed");
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setRequestMethod(method);
                    c.setConnectTimeout(30000);
                    c.setReadTimeout(60000);
                    JSONObject h = new JSONObject(headersJson);
                    Iterator<String> it = h.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        c.setRequestProperty(k, h.getString(k));
                    }
                    if (body != null && !body.isEmpty()) {
                        c.setDoOutput(true);
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                        }
                    }
                    int status = c.getResponseCode();
                    InputStream is = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    String text = is == null ? "" : readAll(is);
                    JSONObject hdr = new JSONObject();
                    for (Map.Entry<String, List<String>> e : c.getHeaderFields().entrySet()) {
                        if (e.getKey() != null && !e.getValue().isEmpty()) {
                            hdr.put(e.getKey().toLowerCase(Locale.ROOT), e.getValue().get(0));
                        }
                    }
                    result = new JSONObject().put("status", status).put("headers", hdr).put("body", text).toString();
                } catch (Exception e) {
                    result = errorJson(e);
                }
                reply(id, result);
            });
        }

        @JavascriptInterface
        public void ssh(final String id, final String host, final String user,
                        final String password, final String script) {
            pool.execute(() -> {
                String result;
                Session session = null;
                try {
                    JSch jsch = new JSch();
                    session = jsch.getSession(user, host, 22);
                    session.setPassword(password);
                    session.setConfig("StrictHostKeyChecking", "no");
                    session.setConfig("PreferredAuthentications", "password,keyboard-interactive");
                    session.connect(30000);
                    ChannelExec ch = (ChannelExec) session.openChannel("exec");
                    ch.setCommand("bash -s");
                    ch.setInputStream(new ByteArrayInputStream(script.getBytes(StandardCharsets.UTF_8)));
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    ByteArrayOutputStream err = new ByteArrayOutputStream();
                    ch.setOutputStream(out);
                    ch.setErrStream(err);
                    ch.connect(30000);
                    long end = System.currentTimeMillis() + 15 * 60 * 1000L;
                    while (!ch.isClosed() && System.currentTimeMillis() < end) Thread.sleep(500);
                    int code = ch.isClosed() ? ch.getExitStatus() : -1;
                    ch.disconnect();
                    result = new JSONObject().put("code", code)
                            .put("out", new String(out.toByteArray(), StandardCharsets.UTF_8))
                            .put("err", new String(err.toByteArray(), StandardCharsets.UTF_8)).toString();
                } catch (Exception e) {
                    result = errorJson(e);
                } finally {
                    if (session != null) session.disconnect();
                }
                reply(id, result);
            });
        }
    }
}
