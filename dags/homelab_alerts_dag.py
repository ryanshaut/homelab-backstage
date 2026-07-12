"""
homelab_alerts_dag.py
=====================
Second example Airflow DAG — simple alerting pipeline.
"""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator


def check_alerts(**context):
    """Placeholder: check for any homelab alert conditions."""
    print("Checking homelab alerts…")
    return []


with DAG(
    dag_id="homelab_alerts_dag",
    description="Check homelab alert conditions (Backstage demo DAG)",
    start_date=datetime(2024, 1, 1),
    schedule_interval=timedelta(minutes=15),
    catchup=False,
    default_args={
        "owner": "platform-team",
        "retries": 0,
    },
    tags=["homelab", "alerts"],
) as dag:

    PythonOperator(
        task_id="check_alerts",
        python_callable=check_alerts,
    )
