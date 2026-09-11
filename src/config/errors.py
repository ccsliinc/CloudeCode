"""The named failures configuration can raise.

Carved out of the flat ``src/config.py`` by slice S5. Body byte-exact.
It lives in its own module so a caller can catch it without importing
the settings machinery, which is what ``src/main.py`` does at boot."""

from pathlib import Path


class StateDirUnavailableError(RuntimeError):
    """Raised when the resolved state directory cannot be created.

    Description: named, catchable failure for ``Settings.get_state_dir()``.
      A server that cannot create its own state directory must refuse to
      start with a clear message, never silently fall back to a temp
      directory and never surface as an opaque unhandled traceback. See
      ``src/main.py``'s module-level call to ``get_state_dir()`` for how
      this is turned into a startup-failure message the user sees.
    Inputs: path (Path) - the directory ``get_state_dir()`` tried to
      create. cause (OSError) - the underlying filesystem error.
    Output: exception instance whose message names both the path and the
      original OS error.
    """

    def __init__(self, path: Path, cause: OSError) -> None:
        self.path = path
        self.cause = cause
        super().__init__(
            f"CloudeCode state directory unavailable: could not create "
            f"'{path}' ({cause.__class__.__name__}: {cause}). Set "
            f"CLOUDE_STATE_DIR to a writable path and restart. Refusing "
            f"to fall back to a temp directory for state you depend on."
        )
