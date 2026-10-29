"""QR code generation for Gel-Al pickup codes."""
import re
import secrets

import qrcode
import qrcode.image.svg

# No 0/O or 1/I so codes are easy to read aloud and type.
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_RE = re.compile(r"^EB2B-[A-Z2-9]{6}$")


def new_code() -> str:
    return "EB2B-" + "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))


def is_valid_code(code: str) -> bool:
    return bool(CODE_RE.match(code))


def pickup_url(base_url: str, code: str) -> str:
    return f"{base_url.rstrip('/')}/?teslim={code}"


def qr_svg(data: str) -> str:
    """Return a standalone SVG document encoding `data`."""
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
        image_factory=qrcode.image.svg.SvgPathImage,
    )
    qr.add_data(data)
    qr.make(fit=True)
    return qr.make_image().to_string(encoding="unicode")
