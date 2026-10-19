from __future__ import annotations

from functools import lru_cache
from typing import Any

import jwt
from fastapi import HTTPException, status
from jwt import PyJWKClient

JWKS_ASYMMETRIC_ALGORITHMS = ("ES256", "RS256", "EdDSA")


def auth_configuration_error(settings: dict[str, Any]) -> str | None:
    """
    Return a human-readable configuration error, or None if verification can run.
    """

    supabase_url = settings.get("supabase_url") or ""
    jwt_secret = settings.get("supabase_jwt_secret") or ""

    if supabase_url or jwt_secret:
        return None

    return (
        "Server auth is not configured. Add SUPABASE_URL to backend/.env "
        "(required for ES256/JWKS signing used by this project). "
        "Only if your project still uses legacy HS256 JWTs, set SUPABASE_JWT_SECRET instead."
    )


@lru_cache
def _jwks_client(supabase_url: str) -> PyJWKClient:
    base = supabase_url.rstrip("/")
    jwks_url = f"{base}/auth/v1/.well-known/jwks.json"
    return PyJWKClient(jwks_url, cache_keys=True)


def _decode_hs256(token: str, jwt_secret: str) -> dict[str, Any]:
    return jwt.decode(
        token,
        jwt_secret,
        algorithms=["HS256"],
        audience="authenticated",
    )


def _decode_jwks(token: str, supabase_url: str) -> dict[str, Any]:
    client = _jwks_client(supabase_url)
    signing_key = client.get_signing_key_from_jwt(token)

    return jwt.decode(
        token,
        signing_key.key,
        algorithms=list(JWKS_ASYMMETRIC_ALGORITHMS),
        audience="authenticated",
    )


def verify_supabase_access_token(
    token: str,
    settings: dict[str, Any],
) -> dict[str, Any]:
    """
    Verify a Supabase Auth access token (JWT).
    Identity is taken only from verified claims — never from the request body.
    """

    config_error = auth_configuration_error(settings)

    if config_error:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=config_error,
        )

    if not token or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing access token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = token.strip()
    supabase_url = settings.get("supabase_url") or ""
    jwt_secret = settings.get("supabase_jwt_secret") or ""

    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid access token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    algorithm = str(header.get("alg") or "")

    try:
        if algorithm == "HS256":
            if not jwt_secret:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=(
                        "This access token uses legacy HS256 signing. "
                        "Set SUPABASE_JWT_SECRET in backend/.env "
                        "(Project Settings → API → JWT Secret)."
                    ),
                )
            payload = _decode_hs256(token, jwt_secret)
        else:
            if not supabase_url:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=(
                        f"This access token uses {algorithm or 'asymmetric'} signing. "
                        "Set SUPABASE_URL in backend/.env to your project URL "
                        "(e.g. https://YOUR_REF.supabase.co) for JWKS verification."
                    ),
                )
            payload = _decode_jwks(token, supabase_url)

    except HTTPException:
        raise
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Access token has expired. Sign in again.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid access token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Could not verify access token: {exc}",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user_id = payload.get("sub")

    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token is missing a user id.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return {
        "user_id": user_id,
        "email": payload.get("email"),
        "role": payload.get("role"),
    }
