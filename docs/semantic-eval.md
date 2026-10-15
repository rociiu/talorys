# Semantic surfaces eval

Model: `@cf/baai/bge-m3`  
Date: 2026-10-15T04:02:21.038Z  
Floor: 0.55

Result: FAIL (13/18 cases pass)

| Case | Query | Kind | Target | Target cosine | Rank | Best distractor | Distractor cosine | Prompt section | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| EX-T1 | doc appt soon? | positive | patel | 0.607 | 1 | dentist | 0.577 | 2 items | pass |
| EX-T2 | travel prep? | positive | passport | 0.641 | 1 | brakes | 0.519 | 1 item | pass |
| EX-T3 | car stuff? | positive | brakes | 0.640 | 1 | gutters | 0.531 | 1 item | pass |
| EX-T4 | doc appt soon? | negative | — | — | — | dentist | 0.577 | 1 item | FAIL |
| EX-T5 | gm | negative | — | — | — | router | 0.456 | none | pass |
| EX-T6 | capital of france | negative | — | — | — | lisbon | 0.407 | none | pass |
| EX-N1 | gift ideas for dad? | positive | skillet | 0.608 | 1 | mom-birthday | 0.543 | 1 item | pass |
| EX-N2 | door code? | positive | keypad | 0.600 | 1 | garage | 0.571 | 2 items | pass |
| EX-N3 | dogs ok here? | positive | lease | 0.585 | 1 | review | 0.510 | 1 item | pass |
| EX-N4 | grocery list? | negative | — | — | — | mom-birthday | 0.603 | 3 items | FAIL |
| EX-N5 | who won last nite | negative | — | — | — | recipes | 0.459 | none | pass |
| EX-N6 | thx | negative | — | — | — | plants | 0.420 | none | pass |
| EX-A1 | garbage night? | positive | bins | 0.492 | 5 | gutters | 0.557 | 1 item | FAIL |
| EX-A2 | bill reminders? | positive | rent | 0.550 | 4 | bins | 0.618 | 3 items | pass |
| EX-A3 | meds reminders? | positive | vitamin | 0.503 | 5 | bins | 0.557 | 1 item | FAIL |
| EX-A4 | plumber? | negative | — | — | — | gutters | 0.563 | 1 item | FAIL |
| EX-A5 | weather tmrw | negative | — | — | — | umbrella | 0.478 | none | pass |
| EX-A6 | hi | negative | — | — | — | review | 0.534 | none | pass |

## Informational rows

| Row | Query | Against | Cosine |
| --- | --- | --- | --- |
| XT-weather-umbrella | weather tmrw | umbrella reminder | 0.478 |
| XT-trash-current | trash | bins reminder, current text | 0.540 |
| XT-trash-slim | trash | bins reminder, slim text | 0.611 |
| XT-trash-reminder-current | do i have a reminder about trash | bins reminder, current text | 0.699 |
| XT-trash-reminder-slim | do i have a reminder about trash | bins reminder, slim text | 0.749 |
| XT-garbage-night-current | garbage night? | bins reminder, current text | 0.492 |
| XT-garbage-night-slim | garbage night? | bins reminder, slim text | 0.584 |
