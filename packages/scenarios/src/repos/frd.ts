import type { RepoOverlay } from '../types';

/** keybank/FRD00/fraud-scoring-engine: Python 3.12 + FastAPI real-time fraud scoring. */
export const FRD_REPO = 'keybank/FRD00/fraud-scoring-engine';

export const FRD_PATHS = {
  cifClient: 'src/fraud_scoring_engine/clients/cif_client.py',
  customerFeatures: 'src/fraud_scoring_engine/features/customer.py',
} as const;

const CIF_CLIENT = `"""Client for CIF customer-profile-api."""

from __future__ import annotations

import os
from collections.abc import Awaitable, Callable
from typing import Any

import httpx

CIF_BASE_URL = os.environ.get("CIF_BASE_URL", "https://cif.internal.keybank.example")


class CifClient:
    def __init__(self, http: httpx.AsyncClient, token: Callable[[], Awaitable[str]]) -> None:
        self._http = http
        self._token = token

    async def get_profile(self, customer_id: str) -> dict[str, Any]:
        resp = await self._http.get(
            f"{CIF_BASE_URL}/v1/customers/{customer_id}/profile",
            headers={"Authorization": f"Bearer {await self._token()}"},
            timeout=1.5,
        )
        resp.raise_for_status()
        return resp.json()
`;

export const FRD_CUSTOMER_FEATURES = `"""Customer-level features for the fraud model: tenure, KYC status, segment, risk rating."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from fraud_scoring_engine.clients.cif_client import CifClient

log = logging.getLogger(__name__)

SEGMENT_RISK = {"RETAIL": 0.0, "PREMIER": -0.05, "PRIVATE": -0.1, "SMALL_BUSINESS": 0.05}


class FeatureUnavailable(Exception):
    """A feature group could not be computed; the scorer falls back to the rules-only model."""


@dataclass(frozen=True)
class CustomerFeatures:
    customer_id: str
    tenure_days: int
    kyc_verified: bool
    segment_risk: float
    risk_rating: str


async def customer_features(cif: CifClient, customer_id: str) -> CustomerFeatures:
    profile = await cif.get_profile(customer_id)
    try:
        return _extract(profile)
    except KeyError:
        log.exception(
            "customer feature extraction failed",
            extra={"customer_ref": customer_id[-4:], "received_keys": sorted(profile)},
        )
        raise FeatureUnavailable("customer") from None


def _extract(profile: dict[str, Any]) -> CustomerFeatures:
    customer_id = profile["customerId"]
    since = datetime.fromisoformat(profile["customerSince"])
    return CustomerFeatures(
        customer_id=customer_id,
        tenure_days=(datetime.now(timezone.utc) - since).days,
        kyc_verified=profile["kycStatus"] == "VERIFIED",
        segment_risk=SEGMENT_RISK.get(profile.get("segment", ""), 0.0),
        risk_rating=profile.get("riskRating", "UNKNOWN"),
    )
`;

export const frdOverlay: RepoOverlay = {
  complete: false,
  files: {
    [FRD_PATHS.cifClient]: CIF_CLIENT,
    [FRD_PATHS.customerFeatures]: FRD_CUSTOMER_FEATURES,
  },
};
