Samples: 336 total, 320 pooled, 16 zone re-wake stalls reported separately, 0 failed or precondition-violated.

### Raw cells (ms): end-to-end median [IQR] · zone→fn call median [IQR]

| shape | gateway | lang | transport | n | e2e median | e2e IQR | call median | call IQR |
|---|---|---|---|---:|---:|---:|---:|---:|
| A | node | go | http1 | 14 | 14 | 12–16 | 6 | 5–7 |
| A | node | go | h2c | 14 | 15 | 14–19 | 7 | 7–7 |
| A | node | rust | http1 | 14 | 14 | 11–15 | 7 | 5–7 |
| A | node | rust | h2c | 14 | 13 | 12–27 | 6 | 5–6 |
| A | bun | go | http1 | 14 | 16 | 15–19 | 6 | 6–8 |
| A | bun | go | h2c | 14 | 20 | 16–25 | 8 | 6–9 |
| A | bun | rust | http1 | 14 | 15 | 14–16 | 6 | 5–7 |
| A | bun | rust | h2c | 14 | 14 | 12–19 | 5 | 4–5 |
| B | node | go | http1 | 7 | 1465 | 1448–1483 | 1457 | 1440–1475 |
| B | node | go | h2c | 7 | 1516 | 1482–1540 | 1486 | 1463–1515 |
| B | node | rust | http1 | 7 | 1441 | 1419–1465 | 1432 | 1411–1456 |
| B | node | rust | h2c | 7 | 1518 | 1464–1540 | 1494 | 1436–1510 |
| B | bun | go | http1 | 7 | 1443 | 1434–1464 | 1416 | 1411–1431 |
| B | bun | go | h2c | 7 | 1455 | 1434–1477 | 1436 | 1413–1448 |
| B | bun | rust | http1 | 7 | 1414 | 1407–1446 | 1395 | 1357–1428 |
| B | bun | rust | h2c | 7 | 1404 | 1396–1441 | 1389 | 1376–1404 |
| C | node | go | http1 | 6 | 3691 | 3193–4262 | 1023 | 889–1409 |
| C | node | rust | http1 | 7 | 3614 | 3139–4032 | 1068 | 882–1172 |
| C | bun | go | http1 | 7 | 3608 | 3598–4101 | 856 | 793–1326 |
| C | bun | go | h2c | 7 | 3649 | 3614–4151 | 868 | 797–1348 |
| C | bun | rust | http1 | 7 | 3612 | 3592–3616 | 788 | 785–828 |
| C | bun | rust | h2c | 7 | 3634 | 3619–4603 | 844 | 767–1765 |
| D | node | go | http1 | 7 | 2341 | 2283–2377 | 37 | 37–39 |
| D | node | go | h2c | 7 | 2289 | 2256–2319 | 54 | 50–58 |
| D | node | rust | http1 | 7 | 2263 | 2256–2275 | 33 | 29–45 |
| D | node | rust | h2c | 7 | 2330 | 2271–2414 | 41 | 40–43 |
| D | bun | go | http1 | 7 | 2994 | 2956–3169 | 68 | 59–73 |
| D | bun | go | h2c | 6 | 2988 | 2967–3052 | 71 | 67–87 |
| D | bun | rust | http1 | 7 | 3271 | 3102–3572 | 59 | 51–79 |
| D | bun | rust | h2c | 7 | 2895 | 2871–3433 | 75 | 58–84 |
| E | node | go | http1 | 7 | 3248 | 3216–3327 | 975 | 911–997 |
| E | node | go | h2c | 7 | 3840 | 3814–3880 | 1578 | 1561–1606 |
| E | node | rust | http1 | 7 | 3792 | 3752–3815 | 1520 | 1459–1569 |
| E | node | rust | h2c | 7 | 3731 | 3686–3790 | 1454 | 1408–1513 |
| E | bun | go | http1 | 7 | 3224 | 3184–3620 | 406 | 347–752 |
| E | bun | go | h2c | 7 | 2980 | 2948–3840 | 116 | 103–645 |
| E | bun | rust | http1 | 7 | 3577 | 2995–3840 | 73 | 64–992 |
| E | bun | rust | h2c | 7 | 3832 | 3013–3866 | 310 | 80–946 |

### Pooled over transport: end-to-end median (n) · zone→fn call median, ms

| shape | node/go | node/rust | bun/go | bun/rust |
|---|---:|---:|---:|---:|
| A warm zone → warm fn | 15 (28) · 7 | 14 (28) · 6 | 18 (28) · 8 | 15 (28) · 5 |
| B warm zone → cold fn | 1483 (14) · 1475 | 1464 (14) · 1445 | 1449 (14) · 1424 | 1412 (14) · 1392 |
| C cold zone → cold fn | 3691 (6) · 1023 | 3614 (7) · 1068 | 3626 (14) · 862 | 3616 (14) · 799 |
| D cold zone → warm fn | 2302 (14) · 45 | 2271 (14) · 41 | 2994 (13) · 70 | 3102 (14) · 64 |
| E cold zone → cold fn, wake-ahead | 3798 (14) · 1320 | 3776 (14) · 1485 | 3206 (14) · 347 | 3705 (14) · 196 |

### Shape deltas, pooled over transport (end-to-end, ms)

| comparison | n | Δ median | 95% CI | p (MW) |
|---|---|---:|---:|---:|
| node/go: C − D (cold fn on top of a cold zone) | 6/14 | 1388 | 838 … 2023 | 0.0020 |
| node/go: B − A (cold fn behind a warm zone) | 14/28 | 1468 | 1443 … 1500 | 1.8e-7 |
| node/go: D − A (cold zone alone) | 14/28 | 2288 | 2237 … 2335 | 1.8e-7 |
| node/go: E − C (wake-ahead effect) | 14/6 | 107 | -953 … 663 | 0.97 |
| node/go: E − D (wake-ahead residual vs a warm fn) | 14/14 | 1496 | 939 … 1576 | 0.00010 |
| node/rust: C − D (cold fn on top of a cold zone) | 7/14 | 1343 | 820 … 1775 | 0.00069 |
| node/rust: B − A (cold fn behind a warm zone) | 14/28 | 1450 | 1427 … 1492 | 1.8e-7 |
| node/rust: D − A (cold zone alone) | 14/28 | 2257 | 2245 … 2326 | 1.8e-7 |
| node/rust: E − C (wake-ahead effect) | 14/7 | 163 | -323 … 680 | 0.74 |
| node/rust: E − D (wake-ahead residual vs a warm fn) | 14/14 | 1505 | 1400 … 1545 | 0.0000093 |
| bun/go: C − D (cold fn on top of a cold zone) | 14/13 | 632 | 510 … 1179 | 0.000094 |
| bun/go: B − A (cold fn behind a warm zone) | 14/28 | 1431 | 1415 … 1455 | 1.8e-7 |
| bun/go: D − A (cold zone alone) | 13/28 | 2976 | 2944 … 3084 | 3.7e-7 |
| bun/go: E − C (wake-ahead effect) | 14/14 | -420 | -1073 … 223 | 0.029 |
| bun/go: E − D (wake-ahead residual vs a warm fn) | 14/13 | 212 | -19 … 858 | 0.10 |
| bun/rust: C − D (cold fn on top of a cold zone) | 14/14 | 514 | 23 … 1125 | 0.0082 |
| bun/rust: B − A (cold fn behind a warm zone) | 14/28 | 1397 | 1388 … 1431 | 1.8e-7 |
| bun/rust: D − A (cold zone alone) | 14/28 | 3087 | 2908 … 3567 | 1.8e-7 |
| bun/rust: E − C (wake-ahead effect) | 14/14 | 89 | -757 … 236 | 0.24 |
| bun/rust: E − D (wake-ahead residual vs a warm fn) | 14/14 | 603 | -303 … 881 | 0.45 |

### Transport: h2c − http1, per shape (zone→fn call time as timed inside the zone, ms)

| comparison | n | Δ median | 95% CI | p (MW) |
|---|---|---:|---:|---:|
| A node/go: h2c − http1 | 14/14 | 1 | 0 … 2 | 0.077 |
| A node/rust: h2c − http1 | 14/14 | -1 | -1 … 1 | 0.63 |
| A bun/go: h2c − http1 | 14/14 | 1 | -1 … 2 | 0.28 |
| A bun/rust: h2c − http1 | 14/14 | -1 | -3 … 0 | 0.0030 |
| B node/go: h2c − http1 | 7/7 | 30 | -25 … 84 | 0.13 |
| B node/rust: h2c − http1 | 7/7 | 61 | -22 … 106 | 0.074 |
| B bun/go: h2c − http1 | 7/7 | 20 | -21 … 40 | 0.31 |
| B bun/rust: h2c − http1 | 7/7 | -5 | -61 … 48 | 1.0 |
| C node/go: h2c − http1 | 0/6 | – | – | – |
| C node/rust: h2c − http1 | 0/7 | – | – | – |
| C bun/go: h2c − http1 | 7/7 | 11 | -923 … 993 | 0.80 |
| C bun/rust: h2c − http1 | 7/7 | 56 | -71 … 982 | 1.0 |
| D node/go: h2c − http1 | 7/7 | 17 | 9 … 23 | 0.0033 |
| D node/rust: h2c − http1 | 7/7 | 9 | -6 … 14 | 0.37 |
| D bun/go: h2c − http1 | 6/7 | 4 | -7 … 40 | 0.43 |
| D bun/rust: h2c − http1 | 7/7 | 16 | -29 … 36 | 0.44 |
| E node/go: h2c − http1 | 7/7 | 603 | 553 … 732 | 0.0022 |
| E node/rust: h2c − http1 | 7/7 | -66 | -165 … 57 | 0.52 |
| E bun/go: h2c − http1 | 7/7 | -289 | -766 … 705 | 0.20 |
| E bun/rust: h2c − http1 | 7/7 | 236 | -919 … 980 | 0.52 |

### Language: rust − go, per shape (zone→fn call time, pooled over gateway and transport, ms)

| comparison | n | Δ median | 95% CI | p (MW) |
|---|---|---:|---:|---:|
| A: rust − go | 56/56 | -1 | -2 … -1 | 0.0000012 |
| B: rust − go | 28/28 | -14 | -48 … 5 | 0.054 |
| C: rust − go | 21/20 | -41 | -461 … 246 | 0.47 |
| D: rust − go | 28/27 | -6 | -20 … 4 | 0.35 |
| E: rust − go | 28/28 | 91 | -249 … 657 | 0.92 |

### Gateway: bun − node, per shape (end-to-end, pooled over lang and transport, ms)

| comparison | n | Δ median | 95% CI | p (MW) |
|---|---|---:|---:|---:|
| A: bun − node | 56/56 | 2 | 0 … 5 | 0.0076 |
| B: bun − node | 28/28 | -32 | -67 … -10 | 0.00093 |
| C: bun − node | 28/13 | 2 | -564 … 489 | 0.17 |
| D: bun − node | 27/28 | 708 | 649 … 948 | 2.9e-8 |
| E: bun − node | 28/28 | -488 | -750 … 103 | 0.18 |

### Wake-ahead timeline (E samples, zone process clock, ms, medians)

| gateway | lang | n | wake fired | request reached handler | overlap | wake done | call |
|---|---|---:|---:|---:|---:|---:|---:|
| node | go | 14 | 1006 | 1394 | 389 | 2701 | 1320 |
| node | rust | 14 | 1005 | 1399 | 390 | 2877 | 1485 |
| bun | go | 14 | 1218 | 1990 | 784 | 2322 | 347 |
| bun | rust | 14 | 1207 | 2029 | 838 | 2107 | 196 |

### Zone boot: process uptime when the request reached the handler (cold-zone shapes, ms, median [IQR])

| shape | gateway | n | median | IQR |
|---|---|---:|---:|---:|
| C | node | 13 | 1481 | 1420–1893 |
| C | bun | 28 | 1984 | 1940–2006 |
| D | node | 28 | 1375 | 1346–1443 |
| D | bun | 27 | 2096 | 2018–2340 |
| E | node | 28 | 1398 | 1381–1411 |
| E | bun | 28 | 2002 | 1972–2035 |

### Zone re-wake stalls (zone up > 5000 ms before the request reached it; not pooled above)

| shape | gateway | fn | e2e | zone uptime at handler | call |
|---|---|---|---:|---:|---:|
| C | node | fn-go-h1 | 13321 | 11105 | 1353 |
| C | node | fn-go-h2 | 7878 | 5378 | 1609 |
| C | node | fn-rust-h2 | 16312 | 14126 | 1302 |
| C | node | fn-go-h2 | 17260 | 15393 | 993 |
| C | node | fn-rust-h2 | 17329 | 15727 | 768 |
| C | node | fn-go-h2 | 19209 | 16889 | 1441 |
| C | node | fn-rust-h2 | 18090 | 16069 | 1159 |
| C | node | fn-go-h2 | 17049 | 15324 | 869 |
| C | node | fn-rust-h2 | 19219 | 16785 | 1585 |
| D | bun | fn-go-h2 | 12067 | 10337 | 947 |
| C | node | fn-go-h2 | 16333 | 14173 | 1320 |
| C | node | fn-rust-h2 | 16407 | 14486 | 1064 |
| C | node | fn-go-h2 | 16138 | 14538 | 759 |
| C | node | fn-rust-h2 | 14874 | 12569 | 1397 |
| C | node | fn-go-h2 | 17124 | 15105 | 1179 |
| C | node | fn-rust-h2 | 20423 | 18639 | 931 |
