#!/usr/bin/env python3
# scripts/check-webrtc-webview.py -- Sonde empirique : RTCPeerConnection
# existe-t-il dans la webview WebKitGTK (le moteur de Tauri sous Linux) ?
#
# Resultat sur Ubuntu 24.04 / WebKitGTK 2.52 (2026-07) : NON --
#   {"rtc":"undefined", "compression":"function", ...}
# meme avec enable-webrtc=True et les plugins GStreamer (webrtcbin, libnice)
# installes : le paquet distribution est COMPILE sans WebRTC
# (strings libwebkit2gtk-4.1.so | grep setLocalDescription -> 0 occurrence).
# C'est ce constat qui a oriente le jeu pair-a-pair vers un transport TCP
# cote Rust plutot que WebRTC -- voir README.md § Remote play.
#
# Prerequis : apt install python3-gi gir1.2-webkit2-4.1 xvfb
# Usage     : xvfb-run -a python3 scripts/check-webrtc-webview.py
# La page fait une boucle locale complete (offer/answer/ICE sans STUN,
# DataChannel, ping/pong) si l'API existe, et imprime un JSON de resultat.
import gi, json, sys
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib

HTML = r"""
<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>
const out = { rtc: typeof RTCPeerConnection, compression: typeof CompressionStream,
              gathering: null, candidates: [], dc: null, roundtrip: null, error: null };
function done() { document.title = 'PROBE:' + JSON.stringify(out); }
setTimeout(() => { if (!document.title.startsWith('PROBE:')) { out.error = 'timeout'; done(); } }, 20000);
(async () => {
  try {
    if (typeof RTCPeerConnection !== 'function') { done(); return; }
    const pc1 = new RTCPeerConnection({ iceServers: [] });   // AUCUN STUN/TURN
    const pc2 = new RTCPeerConnection({ iceServers: [] });
    pc1.onicecandidate = e => { if (e.candidate) { out.candidates.push(e.candidate.candidate.split(' ')[7] || '?'); pc2.addIceCandidate(e.candidate); } };
    pc2.onicecandidate = e => { if (e.candidate) pc1.addIceCandidate(e.candidate); };
    const dc1 = pc1.createDataChannel('tabulon');
    const received = new Promise(res => {
      pc2.ondatachannel = ev => {
        out.dc = 'ondatachannel';
        ev.channel.onmessage = m => { ev.channel.send('pong:' + m.data); };
        ev.channel.onopen = () => {};
      };
      dc1.onmessage = m => res(m.data);
    });
    const offer = await pc1.createOffer();
    await pc1.setLocalDescription(offer);
    await pc2.setRemoteDescription(offer);
    const answer = await pc2.createAnswer();
    await pc2.setLocalDescription(answer);
    await pc1.setRemoteDescription(answer);
    await new Promise(res => {
      if (pc1.iceGatheringState === 'complete') return res();
      pc1.onicegatheringstatechange = () => { if (pc1.iceGatheringState === 'complete') res(); };
      setTimeout(res, 8000);
    });
    out.gathering = pc1.iceGatheringState;
    await new Promise((res, rej) => {
      dc1.onopen = res;
      if (dc1.readyState === 'open') res();
      setTimeout(() => rej(new Error('dc open timeout')), 10000);
    });
    dc1.send('ping');
    out.roundtrip = await Promise.race([received,
      new Promise(res => setTimeout(() => res('recv timeout'), 8000))]);
    done();
  } catch (e) { out.error = String(e && e.message || e); done(); }
})();
</script></body></html>
"""

win = Gtk.OffscreenWindow()
view = WebKit2.WebView()
try:
    view.get_settings().set_enable_webrtc(True)
except Exception as e:
    print("enable-webrtc introuvable:", e, file=sys.stderr)
try:
    view.get_settings().set_enable_media_stream(True)
except Exception as e:
    pass
win.add(view)
win.show_all()

def on_title(view, _pspec):
    t = view.get_title() or ''
    if t.startswith('PROBE:'):
        print(t[6:])
        Gtk.main_quit()

view.connect('notify::title', on_title)
GLib.timeout_add_seconds(30, lambda: (print(json.dumps({'error': 'harness timeout'})), Gtk.main_quit()) and False)
view.load_html(HTML, 'https://localhost/')
Gtk.main()
