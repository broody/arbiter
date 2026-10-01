#!/bin/sh
# Container entrypoint. Needs `--cgroupns=private` and, for this script only,
# SYS_ADMIN (the remount; on AppArmor hosts also `--security-opt
# apparmor=unconfined`), CHOWN, SETUID and SETGID. It remounts the container's
# private cgroup namespace writable and hands it to the unprivileged `arbiter`
# user (cgroup delegation), then drops every capability and starts the
# gateway, which (with workers.cgroup_root "self") runs each worker in its own
# sibling group (prover/README.md, Isolation).
set -eu
mount -o remount,rw /sys/fs/cgroup
# cgroup v2 enables controllers for children only of a group with no member
# processes: move every process (this script, an init) into a `gateway` leaf;
# the gateway runs its workers in siblings.
mkdir -p /sys/fs/cgroup/gateway
for pid in $(cat /sys/fs/cgroup/cgroup.procs); do echo "$pid" > /sys/fs/cgroup/gateway/cgroup.procs 2>/dev/null || true; done
chown -R arbiter:arbiter /sys/fs/cgroup/gateway
for f in /sys/fs/cgroup /sys/fs/cgroup/cgroup.procs /sys/fs/cgroup/cgroup.subtree_control /sys/fs/cgroup/cgroup.threads; do
  chown arbiter:arbiter "$f"
done
exec setpriv --reuid=arbiter --regid=arbiter --init-groups --inh-caps=-all --bounding-set=-all --no-new-privs \
  node /opt/arbiter/prover/server.mjs "${ARBITER_PROVER_CONFIG:-/etc/arbiter/prover.json}"
