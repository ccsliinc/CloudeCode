"""Send several tolerated-failure tmux commands in ONE invocation.

WHAT PROBLEM THIS SOLVES. Launching a session issued FOURTEEN separate
tmux processes before the pane was usable (counted, not estimated, by
tracing a real ``TmuxBackend.start()`` on a throwaway socket). Eight of
them were consecutive ``set-option`` and ``bind-key`` calls that only
decorate the session: mouse mode, extended keys, the wheel bindings, the
escape timeout, ``window-size manual``. Measured on tmux 3.6a at load
average 14, those eight cost **p50 206.41 ms** as separate processes and
**p50 9.35 ms** as one.

TMUX RUNS A COMMAND LIST SEQUENTIALLY IN ONE QUEUE, and a standalone
``;`` argument is what separates the commands in it. That is the whole
mechanism, and it is also the reason two things in this codebase may
never be batched.

**FAILURE ABORTS THE REST OF THE LIST. Measured, not assumed.** On tmux
3.6a, a list whose FIRST command is invalid exits 1 and the second
command does not run; a list whose LAST command is invalid runs the first
and then exits 1. So a naive batch turns "one option this socket will not
take" into "and every option after it was silently skipped", which is
strictly worse than the per-command loop it replaced. :func:`run_optional_batch`
therefore RE-RUNS THE COMMANDS INDIVIDUALLY whenever the batch exits
non-zero. Every command it is given is idempotent, so the re-run restores
exactly the pre-batch behaviour, and it is the only thing that can name
WHICH command failed - tmux's stderr reports the error text but not the
position in the list. The fallback costs nothing in steady state, where
the batch succeeds.

**A COMMAND WHOSE FAILURE MUST STOP THE NEXT ONE CANNOT SHARE A BATCH.**
tmux gives no per-command control over that, so anything with a checked
return code stays its own invocation. In this codebase that means
``new-session``, ``respawn-pane`` and ``pipe-pane`` are never batched with
anything: the first two raise or return a failure result, the third logs
an error, and all three are the commands whose outcome the caller acts on.

**AND NOTHING MAY BE BATCHED ACROSS A SPAWN.** tmux copies the SESSION
environment into a pane's process at spawn time, so ``set-environment``
must complete BEFORE ``new-session`` or ``respawn-pane`` runs. Batching
the environment writes TOGETHER is safe and is done; batching them WITH
the spawn would make the ordering a property of tmux's command queue
rather than of two ordered awaits, and would take the spawn's own return
code with it. See ``tests/test_tmux_launch_batching_real_tmux.py``, which
proves the ordering by reading the value back out of the spawned process
rather than by asserting that two calls happened in order.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, List, NamedTuple, Sequence, Tuple

import structlog

logger = structlog.get_logger()

#: The argument tmux reads as "end of this command, next one follows".
#: It must be its OWN argv element. A semicolon INSIDE an element (the
#: wheel bindings pass ``"copy-mode -e ; send-keys -X -N 3 scroll-up"`` as
#: a single argument) is not a separator and is passed through intact.
COMMAND_SEPARATOR: str = ";"

#: One tmux command as an argv fragment, without the ``tmux -L <socket>``
#: prefix. ``("set-option", "-g", "mouse", "on")``.
TmuxCommand = Sequence[str]


class BatchOutcome(NamedTuple):
    """What a batched send actually did.

    Attributes:
        batched: True when the single invocation exited 0 and every
            command in it ran. False means the batch was refused or
            failed and the commands were re-run one at a time.
        failures: one entry per command that failed on the individual
            re-run, as ``(argv, returncode, stderr)``. Empty when nothing
            failed. This is what names WHICH command failed; the batch's
            own stderr cannot say.
    """

    batched: bool
    failures: Tuple[Tuple[Tuple[str, ...], int, str], ...]


#: A batch that had nothing to do. Not an error, and not a failure.
EMPTY_BATCH: BatchOutcome = BatchOutcome(batched=True, failures=())


def build_batch_argv(commands: Sequence[TmuxCommand]) -> List[str]:
    """Flatten several tmux commands into one argv, ``;`` separated.

    Args:
        commands: the commands, each an argv fragment with no ``tmux -L``
            prefix. Must be non-empty and contain no empty command.

    Returns:
        list[str]: the flattened argv fragment.

    Raises:
        ValueError: when a command is empty, or when any token would be
            read by tmux as a command separator - a token that IS ``;``
            or ENDS in an unescaped ``;``. Such a token would split the
            batch at a place the caller did not intend, running half a
            command with the rest of it as arguments to something else.
            Refusing loudly is the only safe answer; a semicolon in the
            MIDDLE of a token is fine and is passed through.

    Example:
        >>> build_batch_argv([("set-option", "-g", "mouse", "on"),
        ...                   ("set-option", "-s", "escape-time", "0")])
        ['set-option', '-g', 'mouse', 'on', ';', 'set-option', '-s', 'escape-time', '0']
    """
    if not commands:
        raise ValueError("build_batch_argv needs at least one command")
    argv: List[str] = []
    for command in commands:
        tokens = list(command)
        if not tokens:
            raise ValueError("build_batch_argv was given an empty command")
        for token in tokens:
            if token == COMMAND_SEPARATOR or (
                token.endswith(COMMAND_SEPARATOR)
                and not token.endswith("\\" + COMMAND_SEPARATOR)
            ):
                raise ValueError(
                    f"token {token!r} would be read by tmux as a command "
                    f"separator and cannot travel inside a batch"
                )
        if argv:
            argv.append(COMMAND_SEPARATOR)
        argv.extend(tokens)
    return argv


async def run_optional_batch(
    run_tmux: Callable[..., Awaitable[Tuple[int, bytes, bytes]]],
    commands: Sequence[TmuxCommand],
    *,
    note: str,
) -> BatchOutcome:
    """Run tolerated-failure tmux commands in one process, degrading safely.

    ONLY FOR COMMANDS THAT ALREADY PASS ``check=False``. Every caller in
    this codebase treats these failures the way the module docstring
    describes: a socket that will not take an option is not a reason to
    refuse a session. Do not put a command here whose failure must stop
    the next one, or whose return code the caller acts on.

    Args:
        run_tmux: an awaitable ``(*args, check=...) -> (rc, stdout,
            stderr)``. In production this is ``TmuxBackend._run_tmux``.
        commands: the commands to send, each an argv fragment.
        note: a short label naming the group, logged when the batch is
            degraded so the line says WHICH batch it was.

    Returns:
        BatchOutcome: whether the single invocation carried it, plus the
        commands that failed on the individual re-run.

    Example:
        >>> await run_optional_batch(backend._run_tmux, [
        ...     ("set-option", "-g", "mouse", "on"),
        ...     ("set-option", "-s", "escape-time", "0"),
        ... ], note="start_decoration")
        BatchOutcome(batched=True, failures=())
    """
    if not commands:
        return EMPTY_BATCH

    if len(commands) > 1:
        try:
            argv = build_batch_argv(commands)
        except ValueError as exc:
            # A command that cannot travel in a batch is a programming
            # error, not a runtime one, but refusing the whole group over
            # it would be worse than the extra processes. Say so, then do
            # what the code did before batching existed.
            logger.warning(
                "tmux_batch_refused", note=note, error=str(exc)
            )
            return await _run_individually(run_tmux, commands, note=note)

        rc, _, err = await run_tmux(*argv, check=False)
        if rc == 0:
            return BatchOutcome(batched=True, failures=())

        # tmux ABORTS THE REST OF THE LIST at the first error, so this
        # batch applied a PREFIX and skipped the rest. Re-running each
        # command individually restores exactly the pre-batch behaviour
        # (every command here is idempotent) and is the only way to name
        # the one that failed - tmux's stderr carries the error text but
        # not its position in the list.
        logger.warning(
            "tmux_batch_degraded",
            note=note,
            returncode=rc,
            stderr=err.decode("utf-8", errors="replace").strip()[:300],
            commands=len(commands),
        )

    return await _run_individually(run_tmux, commands, note=note)


async def _run_individually(
    run_tmux: Callable[..., Awaitable[Tuple[int, bytes, bytes]]],
    commands: Sequence[TmuxCommand],
    *,
    note: str,
) -> BatchOutcome:
    """Run each command in its own process and collect the failures.

    Args:
        run_tmux: as :func:`run_optional_batch`.
        commands: the commands to run.
        note: the group label, logged with any failure.

    Returns:
        BatchOutcome: ``batched`` False, plus one entry per failure.
    """
    failures: List[Tuple[Tuple[str, ...], int, str]] = []
    for command in commands:
        tokens = tuple(command)
        rc, _, err = await run_tmux(*tokens, check=False)
        if rc != 0:
            stderr = err.decode("utf-8", errors="replace").strip()
            failures.append((tokens, rc, stderr))
            logger.warning(
                "tmux_batch_command_failed",
                note=note,
                command=" ".join(tokens),
                returncode=rc,
                stderr=stderr[:200],
            )
    return BatchOutcome(batched=False, failures=tuple(failures))


def environment_commands(
    target: str, spawn_env: Any
) -> List[TmuxCommand]:
    """Build the ``set-environment`` commands for a pane about to spawn.

    THESE MUST RUN BEFORE THE SPAWN, AND NEVER INSIDE IT. tmux copies the
    SESSION environment into a pane's process at spawn time, so a value
    written after ``respawn-pane`` reaches the NEXT restart and not this
    one - which is how a pane comes back holding a superseded
    ``CLOUDECODE_HOOK_TOKEN`` and 403s on every hook it sends for hours.
    Batching them together keeps them all strictly before the spawn;
    batching them WITH the spawn would make that ordering a property of
    tmux's command queue instead of two ordered awaits, and would lose
    the spawn's own return code.

    Args:
        target: the tmux target the pane belongs to, already made safe.
        spawn_env: mapping of variable name to value, or a falsy value
            for "nothing to inject".

    Returns:
        list: one ``set-environment`` command per pair, in the mapping's
        own order. Empty when there is nothing to write.

    Example:
        >>> environment_commands("cloude_x", {"A": "1"})
        [('set-environment', '-t', 'cloude_x', 'A', '1')]
    """
    if not spawn_env:
        return []
    return [
        ("set-environment", "-t", target, str(var), str(val))
        for var, val in spawn_env.items()
    ]
