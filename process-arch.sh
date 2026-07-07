#!/bin/zsh
S="/private/tmp/claude-501/-Users-yakovterrell/30c40ae9-672d-4384-ad6c-3e8d7963a932/scratchpad"
M=~/Projects/skate-poster/music
OUT=~/Projects/skate-poster/staged
ARMS=(none phonk-hard hiphop-beat classical-piano phonk-brazil-solar none hiphop-oldschool phonk-mountain none classical-cinematic)
i=0; ok=0
while read f; do
  seq=$(printf "%03d" $((20 + i)))
  out="$OUT/${seq}-arch.mp4"
  arm=${ARMS[$((i % 10 + 1))]}
  hasaudio=$(ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 "$f" | head -1)
  vf="scale='min(1080,iw)':-2"
  # text hook on ~40% of clips
  textpart=""
  if [ $((i % 5)) -eq 0 ] || [ $((i % 5)) -eq 2 ]; then
    hk=$(printf "hook%02d.png" $(( (i / 5) % 20 )))
    textpart="yes:$S/hookpngs/$hk"
  fi
  AOPTS=(); FC=""
  if [ "$arm" = "none" ]; then
    if [ -n "$hasaudio" ]; then AOPTS=(-c:a aac -b:a 160k); else AOPTS=(-an); fi
    if [ -n "$textpart" ]; then
      FC="[1:v][0:v]scale2ref=w=iw:h=ih[ovr][base];[base]scale='min(1080,iw)':-2[b2];[b2][ovr]overlay=0:0"
      ffmpeg -nostdin -y -v error -i "$f" -i "${textpart#yes:}" -filter_complex "$FC" -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p "${AOPTS[@]}" -movflags +faststart "$out" && ok=$((ok+1))
    else
      ffmpeg -nostdin -y -v error -i "$f" -vf "$vf" -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p "${AOPTS[@]}" -movflags +faststart "$out" && ok=$((ok+1))
    fi
  else
    OFF=$((i * 7 % 60))
    if [ -n "$hasaudio" ]; then
      AMIX="[2:a]atrim=start=$OFF,asetpts=PTS-STARTPTS,volume=0.35,afade=t=in:d=0.8[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=3[a]"
    else
      AMIX="[2:a]atrim=start=$OFF,asetpts=PTS-STARTPTS,volume=0.5,afade=t=in:d=0.8[a]"
    fi
    if [ -n "$textpart" ]; then
      FC="[1:v][0:v]scale2ref=w=iw:h=ih[ovr][base];[base]scale='min(1080,iw)':-2[b2];[b2][ovr]overlay=0:0[v];$AMIX"
      ffmpeg -nostdin -y -v error -i "$f" -i "${textpart#yes:}" -i "$M/$arm.mp3" -filter_complex "$FC" -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "$out" && ok=$((ok+1))
    else
      ffmpeg -nostdin -y -v error -i "$f" -i "$M/$arm.mp3" -filter_complex "[0:v]scale='min(1080,iw)':-2[v];$(echo "$AMIX" | sed 's/\[2:a\]/[1:a]/')" -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "$out" && ok=$((ok+1))
    fi
  fi
  i=$((i+1))
  [ $((i % 25)) -eq 0 ] && echo "progress: $i/488 (ok=$ok)"
done < "$S/arch1/shuffled.txt"
echo "DONE: processed $ok/488"
