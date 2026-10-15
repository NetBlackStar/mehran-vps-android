// Shared logic for the web (Termux) and Android versions.
// Everything platform specific goes through the transport T:
//   T.http(method, url, headers, body) -> {status, headers, body}   (body is text)
//   T.ssh(host, user, password, script) -> {code, out, err, log?}   (password '' = use the saved SSH key;
//                                                                    on connection errors it throws an Error with .log)
//   T.copyId(host, user, password) -> {code, out, err, log?}   (ssh-keygen + ssh-copy-id)
//   T.get(key) -> string|null     T.put(key, value)
(function (root) {
  const BASE = 'https://www.mehranhost.cloud/api/v1';
  const PROVIDER = 'hetzner';

  class ApiError extends Error {
    constructor(message, code, status) { super(message); this.code = code || 'error'; this.status = status || 0; }
  }

  function Core(T, opts) {
    opts = opts || {};
    const base = opts.base || BASE;
    const provider = opts.provider || PROVIDER;
    const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));

    // ---------- storage ----------
    const getJSON = (k, d) => { try { const v = T.get(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
    const putJSON = (k, v) => T.put(k, JSON.stringify(v));
    const getKey = () => (T.get('api_key') || '').trim();
    const hasKey = () => !!getKey();
    const setKey = k => { k = (k || '').trim(); if (!k) throw new ApiError('کلید خالی است.', 'no_key'); T.put('api_key', k); };
    const getDefaults = () => getJSON('defaults', null);
    // defaults: {plan, location, image, password, label}
    const setDefaults = d => putJSON('defaults', d);
    const awgMap = () => getJSON('awg', {});
    const getAwg = id => awgMap()[String(id)] || null;
    const setAwg = (id, conf) => { const m = awgMap(); m[String(id)] = conf; putJSON('awg', m); };
    const delAwg = id => { const m = awgMap(); delete m[String(id)]; putJSON('awg', m); };

    // ---------- API ----------
    async function api(method, path, params, body, headers) {
      const key = getKey();
      if (!key) throw new ApiError('کلید API پیدا نشد. ابتدا کلید را ذخیره کنید.', 'no_key');
      let url = base + path;
      if (params) {
        const q = Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
        if (q) url += '?' + q;
      }
      const h = Object.assign({ Authorization: 'Bearer ' + key, Accept: 'application/json' }, headers || {});
      let data = null;
      if (body != null) { data = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
      let res;
      try { res = await T.http(method, url, h, data); }
      catch (e) { throw new ApiError('اتصال به سرور برقرار نشد: ' + (e.message || e), 'network'); }
      let j;
      try { j = JSON.parse(res.body); } catch (e) { throw new ApiError('پاسخ نامعتبر از سرور (HTTP ' + res.status + ')', 'bad_response', res.status); }
      if (!j.ok) {
        const er = j.error || {};
        let msg = er.message || ('HTTP ' + res.status);
        if (res.status === 429 && res.headers) {
          const ra = res.headers['retry-after'] || res.headers['Retry-After'];
          if (ra) msg += ' (صبر کنید ' + ra + ' ثانیه)';
        }
        throw new ApiError(msg, er.code, res.status);
      }
      return { data: j.data, meta: j.meta || {} };
    }

    function checkPassword(pw) {
      if (!pw || pw.length < 8 || pw.length > 64) return 'رمز باید بین ۸ تا ۶۴ کاراکتر باشد.';
      if (!/^[\x21-\x7e]+$/.test(pw)) return 'فقط حروف/ارقام/نمادهای کیبورد انگلیسی، بدون فاصله و حروف فارسی.';
      const kinds = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
      if (kinds < 3) return 'رمز باید حداقل سه مورد از این‌ها را داشته باشد: حرف بزرگ، حرف کوچک، عدد، نماد.';
      return null;
    }

    async function account() { return (await api('GET', '/account')).data; }

    async function options() {
      const [locs, plans, imgs] = await Promise.all([
        api('GET', `/abroad/providers/${provider}/locations`),
        api('GET', `/abroad/providers/${provider}/plans`, { available: 1 }),
        api('GET', `/abroad/providers/${provider}/images`, { arch: 'x86' }),
      ]);
      return { locations: locs.data, plans: plans.data, images: imgs.data,
               currency: plans.meta.currency || 'IRT', hours_per_month: plans.meta.hours_per_month,
               default_image: 'ubuntu-24.04' };
    }

    async function servers() {
      const list = (await api('GET', '/abroad/servers')).data || [];
      list.forEach(s => { s.awg = getAwg(s.id); });
      return list;
    }

    async function remove(id) {
      await api('DELETE', '/abroad/servers/' + parseInt(id, 10));
      delAwg(id);
    }

    async function waitActive(id, log, timeoutMs) {
      const end = Date.now() + (timeoutMs || 600000);
      while (Date.now() < end) {
        const s = (await api('GET', '/abroad/servers/' + id, { refresh: 1 })).data;
        if (s.status === 'failed') throw new ApiError('ساخت سرور ناموفق بود (status=failed).', 'failed');
        if (s.status === 'active' && s.ipv4 && s.power === 'running') return s;
        log(`وضعیت: ${s.status} / ${s.power || ''} ...`);
        await sleep(15000);
      }
      throw new ApiError('زمان انتظار برای آماده‌شدن سرور تمام شد؛ لیست سرورها را بررسی کنید.', 'timeout');
    }

    // ---------- AmneziaWG ----------
    const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    function awgScript(p) {
      return `
set -e
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=300"
$APT update -y
$APT install -y software-properties-common curl iptables
add-apt-repository -y ppa:amnezia/ppa
$APT update -y
$APT install -y amneziawg amneziawg-tools
mkdir -p /etc/amnezia/amneziawg && cd /etc/amnezia/amneziawg
umask 077
awg genkey | tee srv.key | awg pubkey > srv.pub
awg genkey | tee cli.key | awg pubkey > cli.pub
IFACE=$(ip -o -4 route show to default | awk '{print $5}' | head -1)
PORT=${p.port}
cat > awg0.conf <<EOF
[Interface]
PrivateKey = $(cat srv.key)
Address = 10.8.1.1/24
ListenPort = $PORT
Jc = ${p.jc}
Jmin = 50
Jmax = 1000
S1 = ${p.s1}
S2 = ${p.s2}
H1 = ${p.h1}
H2 = ${p.h2}
H3 = ${p.h3}
H4 = ${p.h4}
PostUp = iptables -A FORWARD -i awg0 -j ACCEPT; iptables -A FORWARD -o awg0 -j ACCEPT; iptables -t nat -A POSTROUTING -o $IFACE -j MASQUERADE
PostDown = iptables -D FORWARD -i awg0 -j ACCEPT; iptables -D FORWARD -o awg0 -j ACCEPT; iptables -t nat -D POSTROUTING -o $IFACE -j MASQUERADE

[Peer]
PublicKey = $(cat cli.pub)
AllowedIPs = 10.8.1.2/32
EOF
echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-awg.conf
sysctl -p /etc/sysctl.d/99-awg.conf
systemctl enable --now awg-quick@awg0 || awg-quick up awg0
(command -v ufw >/dev/null && ufw allow $PORT/udp || true)
cat <<EOF
=====CLIENT=====
[Interface]
PrivateKey = $(cat cli.key)
Address = 10.8.1.2/32
DNS = 1.1.1.1
Jc = ${p.jc}
Jmin = 50
Jmax = 1000
S1 = ${p.s1}
S2 = ${p.s2}
H1 = ${p.h1}
H2 = ${p.h2}
H3 = ${p.h3}
H4 = ${p.h4}

[Peer]
PublicKey = $(cat srv.pub)
Endpoint = ${p.ip}:$PORT
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 25
EOF
`;
    }

    // ---------- SSH log (downloadable as a file from the UI) ----------
    let sshLog = [];
    const logSsh = m => { sshLog.push('[' + new Date().toISOString() + '] ' + m); };
    const saveSshLog = () => { try { if (sshLog.length) T.put('sshlog', sshLog.join('\n').slice(-300000)); } catch (e) {} };
    const getSshLog = () => (sshLog.length ? sshLog.join('\n') + '\n' : (T.get('sshlog') || ''));
    const clearSshLog = () => { sshLog = []; };

    // One SSH command. secret = root password, or '' to log in with the saved key.
    // Every attempt is written to the SSH log (never the password or the script's stdout,
    // except for the harmless connection test).
    async function sshRun(ip, secret, script, label, showOut) {
      logSsh('>>> ' + label + ' | method=' + (secret ? 'password' : 'key') + ' | root@' + ip + ':22');
      let r;
      try { r = await T.ssh(ip, 'root', secret, script); }
      catch (e) {
        logSsh('FAILED: ' + (e.message || e));
        if (e.log) logSsh('--- ssh debug ---\n' + e.log);
        saveSshLog();
        throw e;
      }
      logSsh('exit code=' + r.code);
      if (showOut && r.out) logSsh('stdout: ' + r.out.trim().slice(-300));
      if (r.err) logSsh('stderr: ' + r.err.slice(-1500));
      if (r.log) logSsh('--- ssh debug ---\n' + r.log);
      saveSshLog();
      return r;
    }

    // Connects first with the root password; if that fails, with the saved SSH key.
    // Returns the secret to use for the next commands ('' means key).
    async function connect(ip, pw, log) {
      const end = Date.now() + 300000;
      let last = '';
      while (Date.now() < end) {
        try {
          const r = await sshRun(ip, pw, 'echo ok', 'test password login', true);
          if (r.code === 0 && /ok/.test(r.out)) { log('اتصال SSH با رمز برقرار شد.'); return pw; }
          last = 'password: ' + (r.err || 'exit ' + r.code);
        } catch (e) { last = 'password: ' + String(e.message || e); }
        log('ورود با رمز ممکن نشد؛ تلاش با کلید SSH...');
        try {
          const r = await sshRun(ip, '', 'echo ok', 'test key login', true);
          if (r.code === 0 && /ok/.test(r.out)) { log('اتصال SSH با کلید برقرار شد.'); return ''; }
          last += ' | key: ' + (r.err || 'exit ' + r.code);
        } catch (e) { last += ' | key: ' + String(e.message || e); }
        log('منتظر SSH...');
        await sleep(8000);
      }
      throw new ApiError('SSH نه با رمز و نه با کلید در دسترس نشد: ' + last.slice(0, 300) +
                         '\n(فایل لاگ SSH را با دکمه «دانلود لاگ SSH» بگیرید.)', 'ssh_timeout');
    }

    // ssh-copy-id: creates (once) an SSH key on this device and appends its public key to
    // /root/.ssh/authorized_keys. Best effort: it only enables the key fallback for later.
    async function installKey(ip, pw, log) {
      logSsh('>>> ssh-copy-id | auth=password | root@' + ip);
      try {
        const r = await T.copyId(ip, 'root', pw);
        logSsh('ssh-copy-id exit code=' + r.code);
        if (r.err) logSsh('stderr: ' + r.err.slice(-1500));
        if (r.log) logSsh('--- ssh debug ---\n' + r.log);
        log(r.code === 0 ? 'کلید SSH روی سرور نصب شد (برای اتصال‌های بعدی).' : 'نصب کلید SSH ناموفق بود (ادامه با رمز).');
      } catch (e) {
        logSsh('ssh-copy-id FAILED: ' + (e.message || e));
        log('نصب کلید SSH ناموفق بود (ادامه با رمز).');
      }
      saveSshLog();
    }

    async function installAwg(ip, pw, log) {
      clearSshLog();
      const p = { port: rnd(20000, 60000), jc: rnd(4, 12), s1: rnd(15, 150), s2: rnd(15, 150),
                  h1: rnd(5, 2 ** 31), h2: rnd(5, 2 ** 31), h3: rnd(5, 2 ** 31), h4: rnd(5, 2 ** 31), ip };
      while (p.s1 + 56 === p.s2) p.s2 = rnd(15, 150);
      const auth = await connect(ip, pw, log);
      if (auth) await installKey(ip, pw, log);
      log('در حال نصب AmneziaWG (چند دقیقه طول می‌کشد)...');
      const r = await sshRun(ip, auth, awgScript(p), 'install AmneziaWG');
      if (r.code !== 0 || r.out.indexOf('=====CLIENT=====') < 0)
        throw new ApiError('نصب AmneziaWG ناموفق بود:\n' + (r.err || r.out).slice(-800), 'awg_failed');
      return r.out.split('=====CLIENT=====')[1].trim() + '\n';
    }

    async function awgOnly(id, ip, pw, log) {
      const conf = await installAwg(ip, pw, log);
      setAwg(id, conf);
      return conf;
    }

    // ---------- create ----------
    function uuid() { return 'vpsm-' + Array.from({ length: 32 }, () => rnd(0, 15).toString(16)).join(''); }

    async function provision(d, log) {
      const err = checkPassword(d.password);
      if (err) throw new ApiError(err, 'bad_password');
      for (const k of ['plan', 'location', 'image']) if (!d[k]) throw new ApiError(`فیلد ${k} انتخاب نشده است.`, 'missing');
      log('بررسی قیمت و موجودی...');
      const q = (await api('GET', '/abroad/quote', { provider, plan: d.plan, location: d.location })).data;
      if (!q.available) throw new ApiError('این پلن در این موقعیت فعلاً موجود نیست؛ موقعیت دیگری را امتحان کنید.', 'plan_unavailable');
      if (!q.can_order) throw new ApiError(`موجودی کیف پول کافی نیست. حداقل لازم: ${q.min_balance_required}، موجودی: ${q.balance} ${q.currency || ''}`, 'low_balance');
      const body = { provider, plan: d.plan, location: d.location, image: d.image, root_password: d.password,
                     max_hourly_price: Math.floor(q.hourly * 1.01) + 1 };
      if (d.label) body.label = d.label.slice(0, 100);
      log('ساخت سرور...');
      const res = (await api('POST', '/abroad/servers', null, body, { 'Idempotency-Key': uuid() })).data;
      let srv = res.server;
      log(`سرور #${srv.id} ساخته شد، منتظر آماده‌شدن...`);
      srv = await waitActive(srv.id, log);
      log('آی‌پی: ' + srv.ipv4);
      const out = { id: srv.id, ip: srv.ipv4, awg: false };
      if (d.awg) {
        await awgOnly(srv.id, srv.ipv4, d.password, log);
        out.awg = true;
        log('AmneziaWG نصب شد.');
      }
      return out;
    }

    return { api, checkPassword, hasKey, setKey, getDefaults, setDefaults, getAwg, account, options, servers,
             remove, provision, awgOnly, waitActive, installAwg, getSshLog };
  }

  root.VpsCore = { Core, ApiError };
  if (typeof module !== 'undefined') module.exports = root.VpsCore;
})(typeof window !== 'undefined' ? window : globalThis);
