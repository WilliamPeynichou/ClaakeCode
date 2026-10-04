#!/bin/sh
# Contrôles techniques du film Claaky (sans audio). Usage : sh qa.sh
set -e
cd "$(dirname "$0")"
for f in portrait landscape; do
  v=out/final_$f.mp4
  echo "== $f =="
  ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt -of compact $v
  ffmpeg -v error -i $v -f null - && echo "décodage complet OK"
  ffmpeg -y -v error -i $v -vf "fps=1/2,scale=270:-1,tile=6x2" -frames:v 1 out/contact_$f.jpg
done
