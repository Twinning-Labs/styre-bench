const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** Shell tail after the operator's preflight/credential setup. No command interpolation.
 * The service must use KillMode=mixed: TERM goes to this supervisor, which forwards it
 * to the pilot and waits for owned-container cleanup. The final KILL still covers the group.
 */
export function supervisedCommand(argv: string[], resultDir: string): string {
  if (argv.length === 0 || argv.some((s) => s.includes("\0")) || !resultDir.startsWith("/")) {
    throw new Error("Expected a command and absolute result directory");
  }
  return `
run_result_dir=${quote(resultDir)}
run_child=''
pending_signal=''
pending_status=''
finish() {
  status=$?
  trap - EXIT
  if [ -n "$pending_status" ]; then status="$pending_status"; fi
  printf '%s\\n' "$status" > "$run_result_dir/exit-code.txt"
  date -u +%FT%TZ > "$run_result_dir/finished-at.txt"
  exit "$status"
}
cancel() {
  signal="$1"
  status="$2"
  if [ -z "$run_child" ]; then
    pending_signal="$signal"
    pending_status="$status"
    return
  fi
  trap '' INT TERM
  pending_signal=''
  pending_status=''
  printf '%s\\n' "$signal" > "$run_result_dir/interrupted.txt"
  if [ -n "$run_child" ]; then
    kill -"$signal" "$run_child" 2>/dev/null || true
    set +e
    wait "$run_child"
    child_status=$?
    set -e
    printf '%s\\n' "$child_status" > "$run_result_dir/interrupted-child-exit-code.txt"
    if [ "$child_status" -eq 70 ]; then status=70; fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'cancel INT 130' INT
trap 'cancel TERM 143' TERM
${argv.map(quote).join(" ")} > "$run_result_dir/run.log" 2>&1 &
run_child=$!
if [ -n "$pending_signal" ]; then cancel "$pending_signal" "$pending_status"; fi
set +e
wait "$run_child"
status=$?
set -e
exit "$status"
`;
}

/** Coupled to supervisedCommand; control-group TERM would race pilot cleanup. */
export const SERVICE_LIFECYCLE = {
  Restart: "no",
  KillMode: "mixed",
  TimeoutStopSec: "45s",
  RuntimeMaxSec: "4h",
  UMask: "0077",
} as const;
