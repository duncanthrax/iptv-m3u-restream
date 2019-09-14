# iptv-m3u-restream

## The situation

You have an IPTV provider that provides an (extended) M3U
playlist file. You want to:

* Add HTTPS encryption to the streams (and probably move
  the unencrypted reception offsite).
* Transcode the streams to a lower bitrate, or convert to
  a uniform video or audio format.

## The solution
Run this software, preferably on an offsite host. It only
requires a Node installation (No NPM modules are required!).
To add HTTPS support, front it with nginx (or similar).

Basic steps just to get it running:
* Check out the repo.
* Copy `restream-cfg-example.json` to `restream-cfg.json`.
* Edit `restream-cfg.json`. See the section below for more
  details.
* Run `node restream.js`. There is no built-in daemon support,
  I recommend to run it in `screen` or use a daemonizer like
  `start-stop-daemon`.

Depending on your config you'll also need to set up a
frontend server to handle HTTPS see the section on nginx
below.


