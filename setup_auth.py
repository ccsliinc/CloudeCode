#!/usr/bin/env python3
"""Setup script for ClaudeTunnel authentication.

Generates TOTP secret and JWT secret, creates config file.
"""
import json
import secrets
import subprocess
import sys
from pathlib import Path


def check_and_setup_venv():
    """Ensure venv exists and has required packages."""
    # Get venv path
    project_root = Path(__file__).parent
    venv_path = project_root / "venv"
    venv_python = venv_path / "bin" / "python3"

    # Check if venv exists
    if not venv_python.exists():
        print("❌ venv not found at: venv/")
        print("Please create it first:")
        print("  python3 -m venv venv")
        sys.exit(1)

    # Check if dependencies are installed
    try:
        import pyotp
        import qrcode
        import jwt
        print("✅ All dependencies available\n")
        return
    except ImportError as e:
        missing_module = str(e).split("'")[1] if "'" in str(e) else "unknown"
        print(f"📦 Missing dependency: {missing_module}")
        print("Installing auth dependencies in venv...\n")

    # Install dependencies
    try:
        result = subprocess.run([
            str(venv_python), "-m", "pip", "install", "-q",
            "pyotp", "qrcode", "pillow", "pyjwt"
        ], check=True, capture_output=True, text=True)

        print("✅ Dependencies installed successfully\n")

        # Re-exec with venv python
        print("🔄 Re-running with venv python...\n")
        subprocess.run([str(venv_python), __file__] + sys.argv[1:])
        sys.exit(0)

    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to install dependencies: {e}")
        print(f"Error output: {e.stderr}")
        sys.exit(1)


def generate_totp_secret():
    """Generate a random TOTP secret."""
    import pyotp
    return pyotp.random_base32()


def generate_jwt_secret():
    """Generate a random JWT secret."""
    return secrets.token_urlsafe(32)


def generate_qr_code(secret: str, account_name: str = "ClaudeTunnel"):
    """Generate QR code for TOTP secret."""
    import pyotp
    import qrcode

    totp = pyotp.TOTP(secret)
    uri = totp.provisioning_uri(
        name=account_name,
        issuer_name="ClaudeTunnel"
    )

    # Generate QR code
    qr = qrcode.QRCode(version=1, box_size=10, border=5)
    qr.add_data(uri)
    qr.make(fit=True)

    # Print ASCII QR code to terminal
    qr.print_ascii()

    # Also save as image
    img = qr.make_image(fill_color="black", back_color="white")
    qr_path = Path.home() / ".claude-tunnel" / "totp-qr.png"
    qr_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(qr_path))

    return uri, qr_path

def main():
    """Main setup function."""
    # Ensure venv has required dependencies
    check_and_setup_venv()

    print("=" * 70)
    print("ClaudeTunnel Authentication Setup")
    print("=" * 70)
    print()

    # Generate secrets
    totp_secret = generate_totp_secret()
    jwt_secret = generate_jwt_secret()

    # Config directory
    config_dir = Path.home() / ".claude-tunnel"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_path = config_dir / "config.json"

    # Check if config already exists
    if config_path.exists():
        print(f"⚠️  Config file already exists at: {config_path}")
        response = input("Do you want to regenerate secrets? (yes/no): ")
        if response.lower() != "yes":
            print("Aborted.")
            return

    # Load example config
    example_path = Path(__file__).parent / "config.example.json"
    with open(example_path) as f:
        config = json.load(f)

    # Update with generated secrets
    config["totp_secret"] = totp_secret
    config["jwt_secret"] = jwt_secret

    # Write config
    with open(config_path, "w") as f:
        json.dump(config, f, indent=2)

    print(f"✅ Configuration file created at: {config_path}")
    print()
    print("=" * 70)
    print("TOTP Setup")
    print("=" * 70)
    print()
    print("Scan this QR code with your authenticator app:")
    print()

    # Generate and display QR code
    uri, qr_path = generate_qr_code(totp_secret)

    print()
    print(f"QR code also saved to: {qr_path}")
    print()
    print(f"Or manually enter this secret in your app: {totp_secret}")
    print()
    print("=" * 70)
    print("Next Steps")
    print("=" * 70)
    print()
    print("1. Scan the QR code above with Google Authenticator, Authy, or similar")
    print("2. Edit your config file to update project paths:")
    print(f"   {config_path}")
    print("3. Update the template_path to your .claude template directory")
    print("4. Restart the ClaudeTunnel server:")
    print("   ./stop.sh && ./start.sh")
    print()
    print("You're all set! Access the app and log in with your TOTP code.")
    print()

if __name__ == "__main__":
    main()
