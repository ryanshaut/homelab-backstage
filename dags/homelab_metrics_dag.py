"""
homelab_metrics_dag.py
======================
Example Airflow DAG for homelab-backstage demo purposes.

This DAG is wired to the 'homelab-data-pipeline' Backstage Component entity
via the `apache-airflow/dags: homelab_metrics_dag` annotation.  In the
Backstage UI (with the Apache Airflow plugin installed) the entity page will
show recent run history for this DAG.
"""

from datetime import datetime, timedelta

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.empty import EmptyOperator


def collect_metrics(**context):
    """Placeholder task: would normally pull metrics from Prometheus, etc."""
    print(f"Collecting homelab metrics at {context['ts']}")
    return {"status": "ok", "metrics_count": 42}


def process_metrics(**context):
    """Placeholder task: transform/aggregate the collected metrics."""
    ti = context["ti"]
    raw = ti.xcom_pull(task_ids="collect_metrics")
    print(f"Processing {raw['metrics_count']} metrics")
    return raw


with DAG(
    dag_id="homelab_metrics_dag",
    description="Collect and process homelab metrics (Backstage demo DAG)",
    start_date=datetime(2024, 1, 1),
    schedule_interval=timedelta(hours=1),
    catchup=False,
    default_args={
        "owner": "platform-team",
        "retries": 1,
        "retry_delay": timedelta(minutes=5),
    },
    tags=["homelab", "metrics"],
) as dag:

    start = EmptyOperator(task_id="start")

    collect = PythonOperator(
        task_id="collect_metrics",
        python_callable=collect_metrics,
    )

    process = PythonOperator(
        task_id="process_metrics",
        python_callable=process_metrics,
    )

    end = EmptyOperator(task_id="end")

    start >> collect >> process >> end
