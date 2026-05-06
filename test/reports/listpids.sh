for p in /proc/[0-9]*; do
  pid=${p##*/}
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
  echo "$pid: $cmd"
done
