"""Create a private production environment file without printing credentials."""

import argparse
import os
import secrets
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--domain", required=True)
    parser.add_argument("--output", type=Path, default=Path(".env.production"))
    args = parser.parse_args()

    values = {
        "FOREMAN_DOMAIN": args.domain,
        "FOREMAN_DB_PASSWORD": secrets.token_hex(32),
        "FOREMAN_MINIO_USER": "foreman" + secrets.token_hex(8),
        "FOREMAN_MINIO_PASSWORD": secrets.token_hex(32),
        "COORDINATOR_SECRET": secrets.token_hex(32),
    }
    content = "".join(f"{key}={value}\n" for key, value in values.items())
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as file:
        file.write(content)
    print(f"Created {args.output} with private permissions")


if __name__ == "__main__":
    main()
