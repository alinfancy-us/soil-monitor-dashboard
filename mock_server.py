#!/usr/bin/env python3
"""
Popup mock server for SoilPulse dashboard.
Serves the real repo files, but injects a mock script before app.js
that overrides globals per scenario (query ?mock=<name> or ?autotest=1).
Repo files are NOT modified.
"""
import os, re, json, http.server

# 服务本仓库根目录（脚本须放在仓库根目录运行，路径从脚本位置推导，便于跨机使用）
REPO = os.path.dirname(os.path.abspath(__file__))

# 场景定义：(name, ua, bluetooth, standalone, beacio_seen)
SCENARIOS = {
    "desktop_supported":      ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", True,  False, True),
    "desktop_safari_unsup":   ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", False, False, False),
    "android_chrome":         ("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", True,  False, False),
    "android_uc_fake":        ("Mozilla/5.0 (Linux; U; Android 13; zh-cn; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.0.0 UCBrowser/13.4.0.1306 Mobile Safari/537.36", True, False, False),
    "ios_safari_beacio":      ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1", True,  False, True),
    "ios_safari_suspended":   ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1", False, False, True),
    "ios_safari_recovers":    ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1", False, False, True),
    "ios_safari_no_beacio":   ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1", False, False, False),
    "ios_safari_beacio_guide":("Mozilla/5.0 (iPhone; CPU iPhone OS 26_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.3 Mobile/15E148 Safari/604.1", False, False, True),
    "ios_standalone":         ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1", False, True,  False),
    "ios_chrome_shell":       ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 CriOS/120.0.0.0 Mobile Safari/604.1", False, False, False),
    "ios_bluefy":             ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1 Bluefy/1.0", True, False, False),
    "ios_old_safari":         ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1", False, False, False),
}

MOCK_JS = """
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var autotest = params.get('autotest') === '1';
  var name = params.get('mock') || params.get('scenario') || (autotest ? window.__mocklist[0] : 'desktop_supported');
  var SC = %(SCENARIO_JSON)s;
  var cur = SC[name] || SC['desktop_supported'];
  // 1) userAgent
  Object.defineProperty(navigator, 'userAgent', { configurable: true, get: function () { return cur[0]; } });
  // 1b) userAgentData（isTrustedChromiumBrand 依赖 brands 含 Google Chrome / Microsoft Edge）
  try {
    Object.defineProperty(navigator, 'userAgentData', {
      configurable: true,
      get: function () {
        return { brands: [{ brand: 'Google Chrome', version: '120' }, { brand: 'Chromium', version: '120' }, { brand: 'Not.A/Brand', version: '8' }], mobile: false, platform: 'macOS' };
      }
    });
  } catch (e) {}
  // 2) bluetooth
  Object.defineProperty(navigator, 'bluetooth', {
    configurable: true,
    get: function () {
      if (!cur[1]) return undefined;
      return {
        requestDevice: function () { return Promise.reject(new DOMException('mock chooser aborted', 'AbortError')); }
      };
    }
  });
  // 2b) 模拟 beacio 恢复注入（仅 ios_safari_recovers）：300ms 后 navigator.bluetooth 重新出现
  if (name === 'ios_safari_recovers') {
    setTimeout(function () {
      Object.defineProperty(navigator, 'bluetooth', {
        configurable: true,
        get: function () {
          return { requestDevice: function () { return Promise.reject(new DOMException('mock chooser aborted', 'AbortError')); } };
        }
      });
    }, 300);
  }
  // 3) standalone (matchMedia)
  var wantStandalone = !!cur[2];
  window.matchMedia = function (q) {
    return { matches: wantStandalone && /standalone/i.test(q), media: q,
      addListener: function(){}, removeListener: function(){},
      addEventListener: function(){}, removeEventListener: function(){}, onchange: null };
  };
  // 4) isSecureContext (localhost 已是 secure context，这里显式保证)
  try { Object.defineProperty(window, 'isSecureContext', { configurable: true, get: function(){ return true; } }); } catch (e) {}
  // 5) beacio_seen
  if (cur[3]) { try { localStorage.setItem('beacio_seen', JSON.stringify({ ts: Date.now(), v: 1 })); } catch (e) {} }
  else { try { localStorage.removeItem('beacio_seen'); } catch (e) {} }
  window.__MOCK = { name: name, ua: cur[0], bluetooth: cur[1], standalone: cur[2], beacio_seen: cur[3], autotest: autotest };

  // 6) 自动驱动：点击 Connect，采集弹窗结果
  window.addEventListener('load', function () {
    setTimeout(function () {
      var btn = document.getElementById('connectBtn');
      var modal = document.getElementById('compatibilityModal');
      var errTxt = document.getElementById('connectErrorText');
      if (!btn) { window.__MOCK_RESULT = { scenario: name, error: 'no connectBtn' }; window.__finishMock(); return; }
      btn.click();   // 触发 handleConnect -> ensureBluetoothEnv
      setTimeout(function () {
        var title = (modal && !modal.classList.contains('hidden'))
          ? document.getElementById('modalTitle').textContent : null;
        var err = (errTxt && !errTxt.classList.contains('hidden'))
          ? errTxt.textContent : null;
        window.__MOCK_RESULT = { scenario: name, modal: title, connectError: err };
        window.__finishMock();
      }, 2200);   // 覆盖 1500ms 等待
    }, 300);
  });

  window.__finishMock = function () {
    var r = window.__MOCK_RESULT || {};
    var logs = [];
    try {
      // 从 localStorage 累计
      var acc = [];
      try { acc = JSON.parse(localStorage.getItem('mock_acc') || '[]'); } catch (e) {}
      acc.push({ scenario: r.scenario, modal: r.modal || '(none)', connectError: r.connectError || '' });
      localStorage.setItem('mock_acc', JSON.stringify(acc));
      if (autotest) {
        var list = window.__mocklist;
        var i = list.indexOf(r.scenario);
        if (i >= 0 && i < list.length - 1) {
          location.href = location.pathname + '?autotest=1&mock=' + list[i + 1];
          return;
        }
        // 汇总
        var host = document.getElementById('app') || document.body;
        var d = document.createElement('div');
        d.id = '__mock_summary';
        d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0f172a;color:#e2e8f0;font:13px/1.5 monospace;padding:12px 16px;max-height:70vh;overflow:auto;white-space:pre-wrap;';
        d.textContent = '== POPUP MOCK SUMMARY ==\\n' + acc.map(function(x){ return x.scenario + '  ->  modal=' + x.modal + '  err=' + x.connectError; }).join('\\n');
        (host || document.body).appendChild(d);
        try { localStorage.removeItem('mock_acc'); } catch (e) {}
      } else {
        document.title = 'MOCK[' + r.scenario + '] modal=' + (r.modal || 'none');
      }
    } catch (e) { console.error('mock finisher error', e); }
  };
})();
</script>
"""

SCENARIO_JSON = json.dumps({k: [v[0], v[1], v[2], v[3]] for k, v in SCENARIOS.items()}, ensure_ascii=False)
SCENARIO_LIST = "['%s']" % "', '".join(SCENARIOS.keys())
MOCK_JS = MOCK_JS.replace("%(SCENARIO_JSON)s", SCENARIO_JSON)
MOCK_JS = MOCK_JS.replace("window.__mocklist", "window.__mocklist" if False else "(window.__mocklist = %s)" % SCENARIO_LIST)

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=REPO, **kw)
    def do_GET(self):
        if self.path.split('?')[0] in ('/', '/index.html'):
            p = os.path.join(REPO, 'index.html')
            with open(p, 'r', encoding='utf-8') as f:
                html = f.read()
            html = html.replace('<script src="page/js/app.js', MOCK_JS + '\n  <script src="page/js/app.js')
            data = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        return super().do_GET()
    def log_message(self, *a):
        pass

if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 8899), Handler).serve_forever()
