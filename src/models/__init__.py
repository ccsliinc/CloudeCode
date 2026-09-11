"""Every wire shape this application speaks, filed by domain.

``src/models.py`` was 2,495 lines holding 75 pydantic classes with no
behaviour on them, which is a directory that was never made. Nothing
moved between levels and nothing was renamed: every name below is the
same object it always was, re-exported here so that no importer had to
change in the commit that split the file.

The one shape worth naming here is ``SessionInfo``, whose fields sit on
TWO levels. See ``src/models/sessions.py``.
"""

from .model_ids import (
    MODEL_ID_PATTERN,
    is_valid_model_id,
    describe_model_id_rejection,
)
from .sessions import (
    SessionStatus,
    LocalServerInfo,
    Session,
    LogEntry,
    SessionStats,
    SessionInfo,
)
from .session_requests import (
    CreateSessionRequest,
    CommandRequest,
    SetUnreadRequest,
    ForkSessionResponse,
    RenameSessionRequest,
)
from .agents import (
    ProviderModelsResponse,
    WrapperListResponse,
    WrapperExamplesResponse,
    TerminalCommandListResponse,
    ReplaceTerminalCommandsRequest,
    ToggleFavoriteCommandRequest,
    AddProviderModelRequest,
    LocalModelsResponse,
)
from .auth import (
    VerifyTOTPRequest,
    AuthTokenResponse,
)
from .themes import (
    UpdatePinnedThemeRequest,
    UpdateThemeRequest,
    ThemeAudioManifest,
    ThemeManifest,
)
from .projects import (
    CreateProjectRequest,
    ProjectResponse,
    UpdateProjectRequest,
    CloneProjectRequest,
)
from .filesystem import (
    DirectoryEntry,
    BrowseResponse,
    MkdirRequest,
    UploadImageResponse,
)
from .adopt import (
    AttachableSession,
    AttachableListingStatus,
    AdoptSessionRequest,
    AdoptSessionResponse,
)
from .restart import (
    RespawnSessionRequest,
    RespawnSessionResponse,
    RestartPreviewOption,
    RestartPlanPreview,
    RestartPreviewResponse,
    RestartSessionResponse,
)
from .common import (
    ErrorResponse,
    SuccessResponse,
    HealthResponse,
)
from .notifications import (
    Toast,
    CreateToastRequest,
    MuteNotificationsRequest,
    NotificationPolicyResponse,
)
from .websocket import (
    WSMessageType,
    ToastNewMessage,
    ToastAckMessage,
    SessionRenamedMessage,
    WSLogMessage,
    WSLocalServerDetectedMessage,
    WSLocalServerLostMessage,
    WSSessionStatusMessage,
    WSCommandMessage,
    WSErrorMessage,
    WSPTYDataMessage,
    WSPTYInputMessage,
    WSPTYResizeMessage,
)
from .config_settings import (
    AgentCommandsUpdate,
    NotificationSecretsUpdate,
    WorkspaceUpdate,
    ServerPrefsUpdate,
    ConfigSettingsUpdateRequest,
)
from .records import (
    SessionRecord,
    SessionImportStatus,
    RecentSessionsResponse,
)
from .attribution import (
    UnattributedSession,
    SessionAttributionPrompt,
    AttributionDeclineRequest,
    AttributionDeclineResponse,
)

__all__ = [
    "AddProviderModelRequest", "AdoptSessionRequest", "AdoptSessionResponse",
    "AgentCommandsUpdate", "AttachableListingStatus", "AttachableSession",
    "AttributionDeclineRequest", "AttributionDeclineResponse", "AuthTokenResponse",
    "BrowseResponse", "CloneProjectRequest", "CommandRequest", "ConfigSettingsUpdateRequest",
    "CreateProjectRequest", "CreateSessionRequest", "CreateToastRequest",
    "DirectoryEntry", "ErrorResponse", "ForkSessionResponse", "HealthResponse",
    "LocalModelsResponse", "LocalServerInfo", "LogEntry", "MODEL_ID_PATTERN",
    "MkdirRequest", "MuteNotificationsRequest", "NotificationPolicyResponse",
    "NotificationSecretsUpdate", "ProjectResponse", "ProviderModelsResponse",
    "RecentSessionsResponse", "RenameSessionRequest", "ReplaceTerminalCommandsRequest",
    "RespawnSessionRequest", "RespawnSessionResponse", "RestartPlanPreview",
    "RestartPreviewOption", "RestartPreviewResponse", "RestartSessionResponse",
    "ServerPrefsUpdate", "Session", "SessionAttributionPrompt", "SessionImportStatus",
    "SessionInfo", "SessionRecord", "SessionRenamedMessage", "SessionStats",
    "SessionStatus", "SetUnreadRequest", "SuccessResponse", "TerminalCommandListResponse",
    "ThemeAudioManifest", "ThemeManifest", "Toast", "ToastAckMessage",
    "ToastNewMessage", "ToggleFavoriteCommandRequest", "UnattributedSession",
    "UpdatePinnedThemeRequest", "UpdateProjectRequest", "UpdateThemeRequest",
    "UploadImageResponse", "VerifyTOTPRequest", "WSCommandMessage",
    "WSErrorMessage", "WSLocalServerDetectedMessage", "WSLocalServerLostMessage",
    "WSLogMessage", "WSMessageType", "WSPTYDataMessage", "WSPTYInputMessage",
    "WSPTYResizeMessage", "WSSessionStatusMessage", "WorkspaceUpdate",
    "WrapperExamplesResponse", "WrapperListResponse", "describe_model_id_rejection",
    "is_valid_model_id",
]
