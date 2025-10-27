"""Configuration management using pydantic-settings."""

from typing import Optional, List
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
import os


class Settings(BaseSettings):
    """Application configuration settings."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )

    # Server Configuration
    host: str = "0.0.0.0"
    port: int = 8000

    # Session Configuration
    default_working_dir: str = "~/claude-projects"
    session_timeout: int = 3600  # seconds (1 hour)

    # Logging Configuration
    log_buffer_size: int = 1000  # lines to keep in memory
    log_file_retention: int = 7  # days
    log_directory: str = "/tmp/claude-code-logs"

    # Tunnel Configuration
    tunnel_provider: str = "cloudflare"
    auto_create_tunnels: bool = True
    tunnel_timeout: int = 30  # seconds to wait for tunnel URL
    use_named_tunnels: bool = True  # Use Cloudflare named tunnels

    # Cloudflare Configuration
    cloudflare_api_token: Optional[str] = None
    cloudflare_zone_id: Optional[str] = None
    cloudflare_domain: str = "claude.adoom.nyc"
    cloudflare_tunnel_name: str = "claude-controller"
    cloudflare_tunnel_id: Optional[str] = None  # Will be set after tunnel creation

    # Security Configuration
    api_key: Optional[str] = None
    allowed_origins: List[str] = ["*"]

    # Tmux Configuration
    tmux_socket_name: str = "claude-controller"
    tmux_session_name: str = "claude-code-session"

    def get_working_dir(self) -> Path:
        """Get the absolute path for the working directory."""
        path = Path(self.default_working_dir).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_log_dir(self) -> Path:
        """Get the absolute path for the log directory."""
        path = Path(self.log_directory).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        return path

    def get_session_metadata_path(self) -> Path:
        """Get the path for session metadata JSON file."""
        return Path(self.log_directory).expanduser() / "session_metadata.json"


# Global settings instance
settings = Settings()
