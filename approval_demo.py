import json
import logging
import os
import time

import requests
from requests.adapters import HTTPAdapter, Retry
from dotenv import load_dotenv


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

WEBHOOK_BASE_URL = os.environ.get('WEBHOOK_BASE_URL')
APPROVALS_URL = f"{os.environ.get('APPROVALS_BASE_URL')}/approvals"
APPROVAL_SUBJECT = os.environ.get('DEFAULT_APPROVAL_SUBJECT')
POLL_INTERVAL_SECONDS = 1


def create_webhook_session():
    session = requests.Session()
    retries = Retry(total=5, backoff_factor=1, status_forcelist=[502, 503, 504])
    session.mount("https://", HTTPAdapter(max_retries=retries))
    session.mount("http://", HTTPAdapter(max_retries=retries))
    return session


def request_callback(session):
    logger.info("Requesting a new callback URL")
    response = session.post(f"{WEBHOOK_BASE_URL}/api/callbacks")
    callback = response.json()
    logger.info("Callback details: %s", callback)
    return callback


def get_access_token():
    client_secret = os.environ.get("KC_SA_PW")
    client_id = os.environ.get("KC_SA_UN")
    discovery_url = os.environ.get("KC_ODIC_DISCOVERY_URI")

    assert client_secret, "KC_SA_PW is not set"
    assert client_id, "KC_SA_UN is not set"
    assert discovery_url, "KC_ODIC_DISCOVERY_URI is not set"

    discovery_response = requests.get(discovery_url)
    discovery_data = discovery_response.json()
    token_url = discovery_data.get("token_endpoint")

    data = {
        "grant_type": "client_credentials",
        "client_id": client_id,
        "client_secret": client_secret,
    }
    response = requests.post(token_url, data=data)
    print(response.text)
    response.raise_for_status()
    return response.json().get("access_token")


def send_approval_request(access_token, callback):
    idempotency_id = os.urandom(5).hex()
    print(f"Generated idempotency ID: {idempotency_id}")

    response = requests.post(
        APPROVALS_URL,
        headers={
            "accept": "application/json",
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        json={
            "idepotency_id": idempotency_id,
            "source": "local",
            "data": json.dumps({
                "for": "a super important thing",
                "details": "additional details about the important thing",
                    "presentation": {
        "type": "ApprovalCard",
        "version": 1,
        "title": "Approve production deployment",
        "description": "Deploy payments-api v2.8.1 to production.",
        "facts": [
            {"label": "Requested by", "value": "Alex"},
            {"label": "Environment", "value": "Production"}
        ],
        "notice": {
            "level": "warning",
            "text": "Includes a database migration."
        },
        "links": [
            {"label": "Deployment plan", "url": "https://example.com/deployments/123"}
        ]
    },
            }),
            "approval_subject": APPROVAL_SUBJECT,
            # "requested_by":"bob@builder.net",
            "requested_by":"somebody@example.com",
            "callback_url": f"{WEBHOOK_BASE_URL}{callback['callback_url']}",
            "callback_method": "POST",
            
        },
    )
    print(f"Response status code: {response.status_code}")
    print(f"Response text: {response.text}")
    response.raise_for_status()

def wait_for_callback(session, callback_id):
    logger.info("Waiting for approval or rejection events...")
    while True:
        response = session.get(f"{WEBHOOK_BASE_URL}/api/webhooks/{callback_id}")
        logger.info("Events response status code: %s", response.status_code)
        if response.status_code == 200:
            logger.info("Events response JSON: %s", response.json())
            if response.json().get('approved') == True:
                return
            elif response.json().get('approved') == False:
                raise Exception(f"Approval request was rejected because {response.json().get('reason')}")
        time.sleep(POLL_INTERVAL_SECONDS)


def main():
    load_dotenv()
    webhook_session = create_webhook_session()
    callback = request_callback(webhook_session)
    access_token = get_access_token()
    send_approval_request(access_token, callback)
    wait_for_callback(webhook_session, callback["id"])


if __name__ == "__main__":
    main()
    