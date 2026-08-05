# AEGIS evaluation results

Scenario: 342 incidents over 12.0 h, fleet of 230 assets, 50 environment disruptions, surge window (3.6, 7.44) h.

| Metric | baseline | priority | priority_opt | aegis |
|---|---|---|---|---|
| Mean first-response (min) | 45.72 | 42.55 | 36.17 | 39.47 |
| p90 first-response (min) | 128.49 | 100.06 | 72.96 | 78.41 |
| Severity-weighted response (min) | 179.33 | 168.83 | 132.44 | 146.11 |
| Incidents reached within window (%) | 61.07 | 60.81 | 67.43 | 66.38 |
| Never reached (%) | 17.24 | 18.97 | 18.07 | 14.08 |
| Fleet utilisation (%) | 28.97 | 28.70 | 34.61 | 39.65 |
| p99 first-response (min) | 208.19 | 205.01 | 146.69 | 155.81 |
| Assignment churn (% of commits) | 0.00 | 0.00 | 2.96 | 6.10 |

## AEGIS vs baseline

- **Mean first-response (min)**: 45.72 -> 39.47 (-13.7%, improved)
- **p90 first-response (min)**: 128.49 -> 78.41 (-39.0%, improved)
- **Severity-weighted response (min)**: 179.33 -> 146.11 (-18.5%, improved)
- **Incidents reached within window (%)**: 61.07 -> 66.38 (+8.7%, improved)
- **Never reached (%)**: 17.24 -> 14.08 (-18.3%, improved)
- **Fleet utilisation (%)**: 28.97 -> 39.65 (+36.9%, improved)
- **p99 first-response (min)**: 208.19 -> 155.81 (-25.2%, improved)
- **Assignment churn (% of commits)**: 0.00 -> 6.10 (+nan%, worse)

## Safety and performance invariants

- `baseline`: resource conflicts=0, double-book attempts blocked=0.0, T1 p99=1.396 ms, T2 solve p99=nan ms, ETA cache hit=77.44%, degraded ETA calls=66.0, DLQ=0.0
- `priority`: resource conflicts=0, double-book attempts blocked=0.0, T1 p99=1.36 ms, T2 solve p99=nan ms, ETA cache hit=78.35%, degraded ETA calls=67.0, DLQ=0.0
- `priority_opt`: resource conflicts=0, double-book attempts blocked=0.0, T1 p99=2.006 ms, T2 solve p99=38.7 ms, ETA cache hit=98.2%, degraded ETA calls=1380.0, DLQ=0.0
- `aegis`: resource conflicts=0, double-book attempts blocked=0.0, T1 p99=2.449 ms, T2 solve p99=38.53 ms, ETA cache hit=97.1%, degraded ETA calls=2236.0, DLQ=0.0
