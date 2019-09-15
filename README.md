# iptv-m3u-restream

## The problem
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

## Getting it to run
Basic steps to get it running:
* Install NodeJS via a mechanism of your choice.
* Clone the repo.
* Copy `restream-cfg-example.json` to `restream-cfg.json`.
* Edit `restream-cfg.json`. See the section below for more
  details.
* Run `node restream.js`. There is no built-in daemon support,
  I recommend to run it in `screen` or use a daemonizer like
  `start-stop-daemon`.
* Point your client software to `http://<ip>:<port>/channels`.
  This is the playlist URL for the `default` transcoding
  profile. To address another profile, use the `profile` URL
  parameter, like `http://<ip>:<port>/channels?profile=mobile`.

It is recommended to front the proxy with nginx to enable HTTPS.
See the section on nginx below.

## Configuration options

__extUrl__: The base URL that your proxy is reachable as, for
example `https://my.offsite.server/iptv/`.

__m3uSrc__: The M3U URL from your IPTV provider. Will usually
contain username and password as URL parameters.

__port__: TCP listening port that the proxy will use.

__numWorkers__: Amount of streaming workers to spawn. Since
this proxy is designed for single clients, they are only
needed when switching channels. Three are enough.

__blacklist__: A list of regular expression strings matching
program names that you want filtered from the M3U list. Useful
for skipping on crap that you don't want.

__profiles__: Transcoding profiles. At least one profile called
`default` must be present. Each profile has three sub-options:
  * `contentType`: The content type that is advertised for the
  resulting stream. Usually `video/mp2t`.
  * `transcoder`: Transcoder binary to spawn. If you want no
  transcoding, use `/bin/cat`. Otherwise, you'll probably use
  ffmpeg. Whatever you use, it must be set up to read video
  from STDIN and output video to STDOUT.
  * `transcoderOpts`: Array of command-line options for the
  transcoder. The transcoder is spawned without a shell, so
  no escaping is needed.

## Nginx setup (recommended, optional)
In any server (hopefully SSL-enabled), pick a path location
for your IPTV service, and link the proxy in like this:

```
location /iptv/ {
    proxy_pass http://127.0.0.1:3666/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
}
```
Here, the URL path is /iptv/ and the proxy port is 3666.
That's all.
