valid 44, excluded 0: []

### b131 (n=22)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 22 | 5 [21, 26] | 18–33 |
| 1 activation: request -> Pod object | 100 | 58 [79, 137] | 63–495 |
| 2 scheduling: Pod -> bound to node | 12 | 11 [8, 20] | 1–37 |
| 3 sandbox + containers start: bound -> first log line | 841 | 470 [434, 903] | 7–1167 |
| 4 runtime boot: first log -> Next listening | 149 | 18 [141, 158] | 133–169 |
| 5 routable: listening -> ready | 678 | 425 [457, 883] | 332–1158 |
| 6 forward + render: ready -> first byte | 47 | 96 [5, 101] | 0–127 |
| total: request -> first byte | 1674 | 465 [1521, 1986] | 1045–2568 |
|   5x kubelet status lag: first log -> pod IP visible in API | 792 | 473 [483, 956] | 244–1189 |
|   5y net: first log -> TCP :3000 from the other node | 799 | 476 [490, 967] | 251–1196 |
|   5y net: first log -> TCP :3000 from the same node | 861 | 408 [602, 1011] | 433–1215 |
|   5z app: listening -> /api/health 200 (same node, direct) | 738 | 484 [407, 891] | 366–1105 |
|   5w activator: first log -> activator marks pod healthy | 794 | 401 [524, 925] | 428–1254 |

### b131 on 10.0.1.118 (n=11)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 22 | 6 [21, 27] | 18–33 |
| 1 activation: request -> Pod object | 87 | 89 [73, 162] | 63–495 |
| 2 scheduling: Pod -> bound to node | 13 | 19 [1, 20] | 1–37 |
| 3 sandbox + containers start: bound -> first log line | 444 | 435 [417, 852] | 7–890 |
| 4 runtime boot: first log -> Next listening | 147 | 16 [141, 157] | 133–169 |
| 5 routable: listening -> ready | 759 | 431 [452, 883] | 332–1065 |
| 6 forward + render: ready -> first byte | 90 | 110 [2, 113] | 0–126 |
| total: request -> first byte | 1593 | 188 [1521, 1710] | 1045–2275 |
|   5x kubelet status lag: first log -> pod IP visible in API | 872 | 541 [415, 956] | 244–1173 |
|   5y net: first log -> TCP :3000 from the other node | 889 | 542 [425, 967] | 251–1185 |
|   5y net: first log -> TCP :3000 from the same node | 916 | 516 [602, 1118] | 433–1206 |
|   5z app: listening -> /api/health 200 (same node, direct) | 787 | 507 [385, 892] | 366–1098 |
|   5w activator: first log -> activator marks pod healthy | 853 | 457 [468, 925] | 428–1210 |

### b131 on 10.0.1.169 (n=11)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 23 | 5 [21, 26] | 19–33 |
| 1 activation: request -> Pod object | 102 | 28 [91, 120] | 75–139 |
| 2 scheduling: Pod -> bound to node | 12 | 7 [9, 16] | 7–26 |
| 3 sandbox + containers start: bound -> first log line | 903 | 470 [562, 1032] | 434–1167 |
| 4 runtime boot: first log -> Next listening | 150 | 21 [139, 161] | 137–165 |
| 5 routable: listening -> ready | 662 | 528 [457, 985] | 372–1158 |
| 6 forward + render: ready -> first byte | 30 | 89 [5, 94] | 4–127 |
| total: request -> first byte | 1856 | 759 [1448, 2207] | 1244–2568 |
|   5x kubelet status lag: first log -> pod IP visible in API | 748 | 480 [483, 963] | 416–1189 |
|   5y net: first log -> TCP :3000 from the other node | 755 | 479 [490, 969] | 423–1196 |
|   5y net: first log -> TCP :3000 from the same node | 766 | 466 [520, 987] | 490–1215 |
|   5z app: listening -> /api/health 200 (same node, direct) | 676 | 484 [407, 891] | 373–1105 |
|   5w activator: first log -> activator marks pod healthy | 774 | 467 [560, 1027] | 499–1254 |

### n131 (n=22)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 22 | 8 [20, 28] | 18–123 |
| 1 activation: request -> Pod object | 97 | 72 [71, 142] | 54–338 |
| 2 scheduling: Pod -> bound to node | 12 | 9 [8, 17] | 1–46 |
| 3 sandbox + containers start: bound -> first log line | 562 | 125 [536, 661] | 476–965 |
| 4 runtime boot: first log -> Next listening | 331 | 30 [320, 349] | 313–372 |
| 5 routable: listening -> ready | 557 | 86 [524, 610] | 363–992 |
| 6 forward + render: ready -> first byte | 45 | 99 [7, 106] | 0–188 |
| total: request -> first byte | 1706 | 291 [1573, 1864] | 1438–2240 |
|   5x kubelet status lag: first log -> pod IP visible in API | 489 | 531 [284, 814] | 86–1350 |
|   5y net: first log -> TCP :3000 from the other node | 496 | 468 [362, 831] | 332–1357 |
|   5y net: first log -> TCP :3000 from the same node | 519 | 509 [414, 923] | 337–16323 |
|   5z app: listening -> /api/health 200 (same node, direct) | 452 | 378 [330, 707] | 285–15990 |
|   5w activator: first log -> activator marks pod healthy | 836 | 83 [821, 903] | 633–1223 |

### n131 on 10.0.1.118 (n=11)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 22 | 11 [20, 31] | 18–123 |
| 1 activation: request -> Pod object | 71 | 82 [60, 142] | 54–277 |
| 2 scheduling: Pod -> bound to node | 11 | 9 [4, 14] | 1–29 |
| 3 sandbox + containers start: bound -> first log line | 536 | 54 [517, 571] | 476–965 |
| 4 runtime boot: first log -> Next listening | 328 | 17 [318, 335] | 313–343 |
| 5 routable: listening -> ready | 530 | 114 [512, 626] | 363–796 |
| 6 forward + render: ready -> first byte | 64 | 146 [19, 165] | 0–188 |
| total: request -> first byte | 1573 | 408 [1520, 1928] | 1438–2075 |
|   5x kubelet status lag: first log -> pod IP visible in API | 593 | 640 [260, 899] | 86–1083 |
|   5y net: first log -> TCP :3000 from the other node | 603 | 565 [344, 909] | 332–1090 |
|   5y net: first log -> TCP :3000 from the same node | 618 | 509 [414, 923] | 337–1107 |
|   5z app: listening -> /api/health 200 (same node, direct) | 430 | 398 [309, 707] | 285–911 |
|   5w activator: first log -> activator marks pod healthy | 834 | 157 [783, 940] | 633–1007 |

### n131 on 10.0.1.169 (n=11)

| phase | median ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 23 | 8 [20, 28] | 19–32 |
| 1 activation: request -> Pod object | 123 | 85 [81, 166] | 76–338 |
| 2 scheduling: Pod -> bound to node | 14 | 14 [8, 22] | 2–46 |
| 3 sandbox + containers start: bound -> first log line | 597 | 201 [557, 758] | 540–889 |
| 4 runtime boot: first log -> Next listening | 349 | 28 [328, 355] | 313–372 |
| 5 routable: listening -> ready | 581 | 75 [529, 604] | 518–992 |
| 6 forward + render: ready -> first byte | 9 | 54 [4, 59] | 0–106 |
| total: request -> first byte | 1715 | 207 [1657, 1864] | 1615–2240 |
|   5x kubelet status lag: first log -> pod IP visible in API | 412 | 510 [284, 794] | 158–1350 |
|   5y net: first log -> TCP :3000 from the other node | 419 | 439 [362, 801] | 355–1357 |
|   5y net: first log -> TCP :3000 from the same node | 439 | 994 [377, 1371] | 350–16323 |
|   5z app: listening -> /api/health 200 (same node, direct) | 456 | 703 [330, 1033] | 317–15990 |
|   5w activator: first log -> activator marks pod healthy | 865 | 79 [825, 903] | 819–1223 |
