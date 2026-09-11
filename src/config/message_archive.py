"""The message-archive block.

Carved out of the flat ``src/config.py`` by slice S5. Body byte-exact."""

from pydantic import BaseModel, Field


class MessageArchiveConfig(BaseModel):
    """Master switch for the message archive subsystem.

    OFF BY DEFAULT, AND THAT DEFAULT IS THE POINT. Turning this on
    creates the ``message_*`` schema, starts a background scheduler that
    walks ``~/.claude/projects`` and indexes the user's own conversations
    into their local database, mounts thirteen API routes and reveals a
    UI screen. None of that may arrive by upgrading, so an install that
    has never heard of this block gets none of it.

    THIS MODEL IS THE DOCUMENTED SHAPE, NOT THE RESOLVER. The value
    actually consulted by the migration gate, the scheduler, the route
    mount and the UI is resolved by
    :func:`src.core.message_archive_flag.resolve`, which reads the same
    ``message_archive`` block plus the ``CLOUDE_MESSAGE_ARCHIVE`` env
    override and returns THREE outcomes rather than a bool. A pydantic
    model cannot express "could not determine": it either parses a value
    or raises, and the malformed-block tolerance every sibling block here
    uses would turn an unreadable switch into a confident False. That is
    exactly the false green this subsystem must not have, so the resolver
    is the authority and this model is what makes the key discoverable,
    typed and settable from the settings surfaces.

    Fields:
        enabled: Whether the message archive subsystem may run at all.
    """

    enabled: bool = False
