"""Configuration management using pydantic-settings."""

from typing import Optional, List, Dict, Any
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path
import os
import json


class ProjectConfig(BaseModel):
    """Configuration for a predefined project."""
    name: str
    path: str
    description: Optional[str] = None


class AuthConfig(BaseModel):
    """Authentication configuration loaded from JSON."""
    totp_secret: str
    jwt_secret: str
    jwt_expiry_minutes: int = 30
    template_path: Optional[str] = None
    projects: List[ProjectConfig] = []


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

    # Authentication Configuration
    auth_config_file: str = "./config.json"

    # Tmux Configuration
    tmux_socket_name: str = "claude-controller"
    tmux_session_name: str = "claude-code-session"

    _auth_config_cache: Optional[AuthConfig] = None

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

    def load_auth_config(self) -> AuthConfig:
        """
        Load authentication configuration from JSON file.

        Returns:
            AuthConfig object with TOTP secret, JWT config, and projects

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If config file is invalid
        """
        if self._auth_config_cache is not None:
            return self._auth_config_cache

        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            with open(config_path) as f:
                data = json.load(f)

            # Convert projects from dict to ProjectConfig objects
            projects_data = data.get("projects", [])
            projects = [ProjectConfig(**p) for p in projects_data]

            auth_config = AuthConfig(
                totp_secret=data["totp_secret"],
                jwt_secret=data["jwt_secret"],
                jwt_expiry_minutes=data.get("jwt_expiry_minutes", 30),
                template_path=data.get("template_path"),
                projects=projects
            )

            # Cache it
            self._auth_config_cache = auth_config
            return auth_config

        except KeyError as e:
            raise ValueError(
                f"Invalid auth config file: missing required field {e}\n"
                f"Check {config_path}"
            )
        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def save_project(self, project: ProjectConfig) -> None:
        """
        Add a new project to the configuration file.

        Args:
            project: ProjectConfig object to add

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If config file is invalid or project already exists
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            # Read current config
            with open(config_path) as f:
                data = json.load(f)

            # Check if project with same name already exists
            projects_data = data.get("projects", [])
            if any(p.get("name") == project.name for p in projects_data):
                raise ValueError(f"Project with name '{project.name}' already exists")

            # Add new project
            projects_data.append({
                "name": project.name,
                "path": project.path,
                "description": project.description
            })

            # Update data
            data["projects"] = projects_data

            # Write back to file
            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )

    def delete_project(self, project_name: str) -> None:
        """
        Delete a project from the configuration file.

        Args:
            project_name: Name of the project to delete

        Raises:
            FileNotFoundError: If config file doesn't exist
            ValueError: If config file is invalid or project doesn't exist
        """
        config_path = Path(self.auth_config_file).expanduser()

        if not config_path.exists():
            raise FileNotFoundError(
                f"Auth config file not found: {config_path}\n"
                f"Run ./setup_auth.py to create it."
            )

        try:
            # Read current config
            with open(config_path) as f:
                data = json.load(f)

            # Find and remove project
            projects_data = data.get("projects", [])
            original_length = len(projects_data)
            projects_data = [p for p in projects_data if p.get("name") != project_name]

            if len(projects_data) == original_length:
                raise ValueError(f"Project '{project_name}' not found")

            # Update data
            data["projects"] = projects_data

            # Write back to file
            with open(config_path, 'w') as f:
                json.dump(data, f, indent=2)

            # Clear cache to force reload
            self._auth_config_cache = None

        except json.JSONDecodeError as e:
            raise ValueError(
                f"Invalid JSON in auth config file: {e}\n"
                f"Check {config_path}"
            )


# Global settings instance
settings = Settings()
