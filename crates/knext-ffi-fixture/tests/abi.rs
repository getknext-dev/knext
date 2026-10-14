//! ABI v1 round-trips: every row of the type table, as an argument and as a
//! return, called through the generated `extern "C"` shims exactly as
//! `bun:ffi` calls them (lowered arguments, a caller-owned 16-byte out slot,
//! an `i32` status, and a paired `knext_ffi_v1_free` for every returned buffer).

mod common;
use common::*;
use knext_ffi::serde_json::{self, Value, json};

const OK: i32 = 0;
const ERR: i32 = 1;
const PANIC: i32 = 2;
const INVALID: i32 = 3;

macro_rules! call {
    ($f:ident ( $($a:expr),* )) => {{
        let mut out: Out = [0, 0];
        let st = unsafe { $f($($a,)* &mut out) };
        (st, out)
    }};
}

fn call_str(f: unsafe extern "C" fn(*const u8, usize, *mut Out) -> i32, s: &[u8]) -> (i32, Out) {
    let (p, l) = arg(s);
    let mut out: Out = [0, 0];
    let st = unsafe { f(p, l, &mut out) };
    (st, out)
}

fn call_json(
    f: unsafe extern "C" fn(*const u8, usize, *mut Out) -> i32,
    v: &Value,
) -> (i32, Value) {
    let s = serde_json::to_vec(v).unwrap();
    let (st, out) = call_str(f, &s);
    let bytes = take(out);
    if st == OK {
        (
            st,
            serde_json::from_slice(&bytes).expect("returned JSON parses"),
        )
    } else {
        (st, Value::String(String::from_utf8(bytes).unwrap()))
    }
}

#[test]
fn abi_version_is_1() {
    assert_eq!(unsafe { knext_ffi_v1_abi() }, 1);
}

#[test]
fn schema_values_are_golden() {
    // FNV-1a 64 of e.g. "mid(Point,Point)->Point" + "Child{name:string,flag:bool}"
    // + "Color[Red|Green|Blue]" + "Point{id:u64,...,ids:vec<u64>,count:option<usize>,
    // deltas:vec<option<i64>>}" (sorted by name).
    let cases: [(&str, unsafe extern "C" fn() -> u64, u64); 11] = [
        ("add", knext_ffi_v1_add_43c960c6_schema, 0x29df491fa1e52ca6),
        (
            "noop",
            knext_ffi_v1_noop_0d4fe413_schema,
            0x7de9f31af1067ff3,
        ),
        (
            "greet",
            knext_ffi_v1_greet_8a119d0c_schema,
            0x8d84ea12e026f80c,
        ),
        (
            "echo_bytes",
            knext_ffi_v1_echo_bytes_0ff3cd4c_schema,
            0x5de1c3c22cb9b66c,
        ),
        (
            "echo_opt_u64",
            knext_ffi_v1_echo_opt_u64_1cbc2610_schema,
            0xb533997dec9bcf90,
        ),
        (
            "echo_point",
            knext_ffi_v1_echo_point_8aec475d_schema,
            0x4710769a1d4730de,
        ),
        ("mid", knext_ffi_v1_mid_c61bad57_schema, 0xe8fcf2e62f09f6d4),
        (
            "echo_vec_point",
            knext_ffi_v1_echo_vec_point_e1008be8_schema,
            0x25b281e1bbeb177f,
        ),
        (
            "fallible_point",
            knext_ffi_v1_fallible_point_480ebe3f_schema,
            0x0b7914bf29e338ec,
        ),
        (
            "next_color",
            knext_ffi_v1_next_color_95dd2ed4_schema,
            0xa34dde499fdb102f,
        ),
        (
            "echo_opt_color",
            knext_ffi_v1_echo_opt_color_d1930232_schema,
            0x27a0954677980521,
        ),
    ];
    for (name, f, want) in cases {
        assert_eq!(unsafe { f() }, want, "{name}_schema()");
    }
}

// ---- by value -----------------------------------------------------------------

#[test]
fn integers_round_trip_at_their_bounds() {
    for v in [i8::MIN, -1, 0, 1, i8::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_i8_cdf4f152(v));
        assert_eq!((st, scalar::<i8>(&out)), (OK, v));
    }
    for v in [i16::MIN, -1, 0, i16::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_i16_3a0f121b(v));
        assert_eq!((st, scalar::<i16>(&out)), (OK, v));
    }
    for v in [i32::MIN, -1, 0, i32::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_i32_c395ed91(v));
        assert_eq!((st, scalar::<i32>(&out)), (OK, v));
    }
    for v in [0, 1, u8::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_u8_4330bed6(v));
        assert_eq!((st, scalar::<u8>(&out)), (OK, v));
    }
    for v in [0, u16::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_u16_19f998df(v));
        assert_eq!((st, scalar::<u16>(&out)), (OK, v));
    }
    for v in [0, u32::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_u32_bb0f9ff5(v));
        assert_eq!((st, scalar::<u32>(&out)), (OK, v));
    }
    for v in [i64::MIN, -(1 << 53) - 1, (1 << 53) + 1, i64::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_i64_06384cc2(v));
        assert_eq!((st, scalar::<i64>(&out)), (OK, v));
    }
    for v in [0, (1 << 53) + 1, u64::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_u64_5289f9ce(v));
        assert_eq!((st, scalar::<u64>(&out)), (OK, v));
    }
    for v in [isize::MIN, -1, isize::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_isize_3c7eb2f1(v));
        assert_eq!((st, scalar::<isize>(&out)), (OK, v));
    }
    for v in [0, usize::MAX] {
        let (st, out) = call!(knext_ffi_v1_echo_usize_cc728625(v));
        assert_eq!((st, scalar::<usize>(&out)), (OK, v));
    }
    let (st, out) = call!(knext_ffi_v1_add_43c960c6(i32::MAX, 1));
    assert_eq!((st, scalar::<i32>(&out)), (OK, i32::MIN), "wrapping add");
}

#[test]
fn floats_and_bool_round_trip() {
    for v in [0.0f32, -1.5, f32::MAX, f32::MIN_POSITIVE, f32::INFINITY] {
        let (st, out) = call!(knext_ffi_v1_echo_f32_3ce3d5ac(v));
        assert_eq!((st, scalar::<f32>(&out).to_bits()), (OK, v.to_bits()));
    }
    for v in [0.0f64, -0.0, 1e300, f64::NEG_INFINITY, std::f64::consts::PI] {
        let (st, out) = call!(knext_ffi_v1_echo_f64_486685cb(v));
        assert_eq!((st, scalar::<f64>(&out).to_bits()), (OK, v.to_bits()));
    }
    let (st, out) = call!(knext_ffi_v1_echo_f64_486685cb(f64::NAN));
    assert!(
        st == OK && scalar::<f64>(&out).is_nan(),
        "NaN crosses by value"
    );
    let (st, out) = call!(knext_ffi_v1_not_3febaaca(true));
    assert_eq!((st, scalar::<u8>(&out)), (OK, 0));
    let (st, out) = call!(knext_ffi_v1_not_3febaaca(false));
    assert_eq!((st, scalar::<u8>(&out)), (OK, 1));
}

// ---- strings ------------------------------------------------------------------

fn string_cases() -> Vec<String> {
    vec![
        "World".into(),
        String::new(),
        "héllo wörld — 日本語 — 👩‍👩‍👧‍👦 — 🦀".into(),
        "nul\0inside\0".into(),
        "x".repeat(1 << 20),
    ]
}

#[test]
fn string_argument_and_return_round_trip() {
    for s in string_cases() {
        let (st, out) = call_str(knext_ffi_v1_echo_string_0fd53432, s.as_bytes());
        assert_eq!(st, OK);
        assert_eq!(take_string(out), s, "echo_string(String) -> String");

        let (st, out) = call_str(knext_ffi_v1_greet_8a119d0c, s.as_bytes());
        assert_eq!((st, take_string(out)), (OK, format!("Hello, {s}!")));

        let (st, out) = call_str(knext_ffi_v1_greet_ref_403508c6, s.as_bytes());
        assert_eq!(
            (st, take_string(out)),
            (OK, format!("Hello, {s}!")),
            "&str argument"
        );

        let (st, out) = call_str(knext_ffi_v1_str_len_0ef98dc4, s.as_bytes());
        assert_eq!((st, scalar::<u64>(&out)), (OK, s.len() as u64));
    }
}

#[test]
fn empty_string_argument_may_be_a_null_pointer_and_empty_return_is_0_0() {
    let mut out: Out = [7, 7];
    let st = unsafe { knext_ffi_v1_echo_string_0fd53432(std::ptr::null(), 0, &mut out) };
    assert_eq!(
        (st, out),
        (OK, [0, 0]),
        "empty return is (0, 0), nothing allocated"
    );
    let mut out: Out = [7, 7];
    let st = unsafe { knext_ffi_v1_empty_string_04c94897(&mut out) };
    assert_eq!((st, out), (OK, [0, 0]));
}

#[test]
fn len_0_accepts_a_null_or_a_dangling_pointer_and_never_dereferences_it() {
    // Bun may pass an empty typed array as a NON-null pointer, the generated
    // wrapper passes NULL; with len == 0 the shim must not touch either.
    let dangling = std::ptr::NonNull::<u8>::dangling().as_ptr() as *const u8;
    let unmapped = 0x10 as *const u8; // would fault if read
    for p in [std::ptr::null(), dangling, unmapped] {
        let mut out: Out = [0, 0];
        assert_eq!(
            unsafe { knext_ffi_v1_greet_ref_403508c6(p, 0, &mut out) },
            OK
        );
        assert_eq!(take_string(out), "Hello, !", "&str");
        let mut out: Out = [0, 0];
        assert_eq!(unsafe { knext_ffi_v1_greet_8a119d0c(p, 0, &mut out) }, OK);
        assert_eq!(take_string(out), "Hello, !", "String");
        let mut out: Out = [0, 0];
        assert_eq!(
            unsafe { knext_ffi_v1_bytes_len_f460e1fa(p, 0, &mut out) },
            OK
        );
        assert_eq!(scalar::<u64>(&out), 0, "&[u8]");
        let mut out: Out = [7, 7];
        assert_eq!(
            unsafe { knext_ffi_v1_echo_bytes_0ff3cd4c(p, 0, &mut out) },
            OK
        );
        assert_eq!(out, [0, 0], "Vec<u8>");
        let mut out: Out = [0, 0];
        assert_eq!(
            unsafe { knext_ffi_v1_echo_point_8aec475d(p, 0, &mut out) },
            INVALID
        );
        assert!(
            take_string(out).contains("`p`"),
            "an empty JSON argument is invalid input, not a read"
        );
        let mut out: Out = [0, 0];
        let st = unsafe { knext_ffi_v1_concat_c0077780(p, 0, p, 0, &mut out) };
        assert_eq!((st, out), (OK, [0, 0]), "two empty strings");
    }
}

#[test]
fn two_large_string_arguments() {
    let a = "a".repeat(3 << 20);
    let b = "é".repeat(1 << 20);
    let mut out: Out = [0, 0];
    let st =
        unsafe { knext_ffi_v1_concat_c0077780(a.as_ptr(), a.len(), b.as_ptr(), b.len(), &mut out) };
    assert_eq!(st, OK);
    assert_eq!(take_string(out), format!("{a}{b}"));
}

#[test]
fn invalid_utf8_is_status_3_naming_the_argument() {
    let (st, out) = call_str(knext_ffi_v1_greet_8a119d0c, &[0x66, 0xff, 0x6f]);
    assert_eq!(st, INVALID);
    let msg = take_string(out);
    assert!(msg.contains("`name`") && msg.contains("UTF-8"), "{msg}");
    let (st, _) = call_str(knext_ffi_v1_greet_ref_403508c6, &[0xc3]);
    assert_eq!(st, INVALID);
}

// ---- bytes ----------------------------------------------------------------------

#[test]
fn bytes_argument_and_return_round_trip() {
    let cases: Vec<Vec<u8>> = vec![
        vec![],
        vec![0],
        (0..=255).collect(),
        (0..(1u32 << 20)).map(|i| (i * 7) as u8).collect(),
    ];
    for b in cases {
        let (st, out) = call_str(knext_ffi_v1_echo_bytes_0ff3cd4c, &b);
        assert_eq!(st, OK);
        if b.is_empty() {
            assert_eq!(out, [0, 0], "empty Vec<u8> return is (0, 0)");
        }
        assert_eq!(take(out), b);
        let (st, out) = call_str(knext_ffi_v1_sum_bytes_0620d4ae, &b);
        assert_eq!(
            (st, scalar::<u64>(&out)),
            (OK, b.iter().map(|&x| x as u64).sum::<u64>())
        );
        let (st, out) = call_str(knext_ffi_v1_bytes_len_f460e1fa, &b);
        assert_eq!((st, scalar::<u64>(&out)), (OK, b.len() as u64));
    }
    let (st, out) = call!(knext_ffi_v1_empty_bytes_5bca29bd());
    assert_eq!((st, out), (OK, [0, 0]));
    let (st, out) = call!(knext_ffi_v1_make_bytes_0b1567ca(300));
    assert_eq!(st, OK);
    assert_eq!(take(out), (0..300u32).map(|i| i as u8).collect::<Vec<_>>());
}

// ---- unit -------------------------------------------------------------------------

#[test]
fn unit_return_writes_nothing() {
    let mut out: Out = [0xdead, 0xbeef];
    assert_eq!(unsafe { knext_ffi_v1_noop_0d4fe413(&mut out) }, OK);
    assert_eq!(out, [0xdead, 0xbeef]);
    assert_eq!(unsafe { knext_ffi_v1_unit_ret_1d8bcdfd(5, &mut out) }, OK);
    assert_eq!(out, [0xdead, 0xbeef]);
}

// ---- records, enums, Option, Vec ---------------------------------------------------

fn point(label: &str) -> Value {
    json!({
        "id": "18446744073709551615",
        "delta": "-9223372036854775808",
        "size": "9007199254740993",
        "offset": "-9007199254740993",
        "x": 1.5, "y": -2.25, "small": 255,
        "label": label, "tags": ["a", "", "日本"],
        "maybe": "9007199254740993",
        "color": "Blue",
        "raw": [0, 1, 255],
        "child": {"name": "kid", "flag": true},
        "ids": ["0", "18446744073709551615"],
        "count": "18446744073709551615",
        "deltas": [
            "-9223372036854775808",
            null,
            "-9007199254740993",
            "9007199254740993",
            "9223372036854775807"
        ]
    })
}

#[test]
fn record_round_trips_with_64_bit_fields_as_decimal_strings() {
    let p = point("p ☃ \u{0} \"q\"");
    let (st, back) = call_json(knext_ffi_v1_echo_point_8aec475d, &p);
    assert_eq!(st, OK, "{back}");
    assert_eq!(
        back, p,
        "every field, including 64-bit values above 2^53, round-trips exactly"
    );
    assert!(back["id"].is_string() && back["ids"][1].is_string() && back["maybe"].is_string());

    let mut q = point("q");
    q["maybe"] = Value::Null;
    q["child"] = Value::Null;
    q["count"] = Value::Null;
    q["deltas"] = json!([]);
    let (st, back) = call_json(knext_ffi_v1_echo_point_8aec475d, &q);
    assert_eq!((st, back), (OK, q), "Option fields as null");
}

#[test]
fn option_usize_and_vec_option_i64_fields_round_trip_as_decimal_strings() {
    // `count: Option<usize>` and `deltas: Vec<Option<i64>>`: a 64-bit integer
    // inside an Option or a Vec inside a record field is a decimal string too.
    for count in [
        Value::Null,
        json!("0"),
        json!(usize::MAX.to_string()),
        json!(((1u64 << 53) + 1).to_string()),
    ] {
        let mut p = point("c");
        p["count"] = count.clone();
        p["deltas"] = json!([
            i64::MIN.to_string(),
            null,
            (-(1i64 << 53) - 1).to_string(),
            "-1",
            ((1i64 << 53) + 1).to_string(),
            i64::MAX.to_string(),
        ]);
        let (st, back) = call_json(knext_ffi_v1_echo_point_8aec475d, &p);
        assert_eq!(st, OK, "{back}");
        assert_eq!(back, p, "count = {count}");
        assert_eq!(back["count"], count, "exact, above 2^53 and at usize::MAX");
        assert!(back["deltas"][0].is_string() && back["deltas"][1].is_null());
    }
    assert_eq!(usize::MAX as u64, u64::MAX, "ABI v1 is 64-bit");

    // A JSON number in either field is refused (status 3), as is an
    // out-of-range decimal string.
    let bad: [(&str, Value); 6] = [
        ("count", json!(5)),
        ("count", json!(9_007_199_254_740_993u64)),
        ("count", json!("-1")),
        ("deltas", json!([1])),
        ("deltas", json!([null, -5])),
        ("deltas", json!(["9223372036854775808"])),
    ];
    for (field, v) in bad {
        let mut p = point("bad");
        p[field] = v.clone();
        let (st, msg) = call_json(knext_ffi_v1_echo_point_8aec475d, &p);
        assert_eq!(st, INVALID, "{field} = {v} -> {msg}");
        assert!(msg.as_str().unwrap().contains("`p`"), "{msg}");
    }
}

#[test]
fn two_record_arguments() {
    let mut a = point("a");
    a["x"] = json!(0.0);
    let mut b = point("b");
    b["x"] = json!(10.0);
    let sa = serde_json::to_vec(&a).unwrap();
    let sb = serde_json::to_vec(&b).unwrap();
    let mut out: Out = [0, 0];
    let st = unsafe {
        knext_ffi_v1_mid_c61bad57(sa.as_ptr(), sa.len(), sb.as_ptr(), sb.len(), &mut out)
    };
    assert_eq!(st, OK);
    let m: Value = serde_json::from_slice(&take(out)).unwrap();
    assert_eq!(m["x"], json!(5.0));
    assert_eq!(m["label"], json!("a"));
}

#[test]
fn invalid_record_json_is_status_3() {
    let bad: Vec<Value> = vec![
        json!({"id": 1}),
        {
            let mut p = point("p");
            p["id"] = json!(1);
            p
        },
        {
            let mut p = point("p");
            p["extra"] = json!(1);
            p
        },
        {
            let mut p = point("p");
            p["color"] = json!("Purple");
            p
        },
        {
            let mut p = point("p");
            p["x"] = Value::Null;
            p
        },
        {
            let mut p = point("p");
            p["id"] = json!("-1");
            p
        },
    ];
    for v in bad {
        let (st, msg) = call_json(knext_ffi_v1_echo_point_8aec475d, &v);
        assert_eq!(st, INVALID, "{v} -> {msg}");
        assert!(msg.as_str().unwrap().contains("`p`"), "{msg}");
    }
    let (st, _) = call_str(knext_ffi_v1_echo_point_8aec475d, b"{not json");
    assert_eq!(st, INVALID);
    let mut trailing = serde_json::to_vec(&point("p")).unwrap();
    trailing.extend_from_slice(b" []");
    let (st, _) = call_str(knext_ffi_v1_echo_point_8aec475d, &trailing);
    assert_eq!(st, INVALID, "trailing data after the JSON value");
    let (st, _) = call_str(knext_ffi_v1_echo_point_8aec475d, b"");
    assert_eq!(st, INVALID, "empty input is not a record");
}

#[test]
fn enums_cross_as_variant_names() {
    let (st, v) = call_json(knext_ffi_v1_next_color_95dd2ed4, &json!("Red"));
    assert_eq!((st, v), (OK, json!("Green")));
    let (st, v) = call_json(knext_ffi_v1_next_color_95dd2ed4, &json!("Blue"));
    assert_eq!((st, v), (OK, json!("Red")));
    let (st, _) = call_json(knext_ffi_v1_next_color_95dd2ed4, &json!("red"));
    assert_eq!(st, INVALID);
    let (st, v) = call_json(knext_ffi_v1_echo_opt_color_d1930232, &json!(null));
    assert_eq!((st, v), (OK, json!(null)));
}

#[test]
fn option_and_vec_top_level_json() {
    let big = json!("9007199254740993");
    assert_eq!(
        call_json(knext_ffi_v1_echo_opt_i64_39cbdcec, &big),
        (OK, big.clone())
    );
    assert_eq!(
        call_json(knext_ffi_v1_echo_opt_i64_39cbdcec, &json!(null)),
        (OK, json!(null))
    );
    let max = json!("18446744073709551615");
    assert_eq!(
        call_json(knext_ffi_v1_echo_opt_u64_1cbc2610, &max),
        (OK, max.clone())
    );
    let (st, _) = call_json(knext_ffi_v1_echo_opt_u64_1cbc2610, &json!(5));
    assert_eq!(
        st, INVALID,
        "a 64-bit integer in JSON must be a decimal string"
    );
    let s = json!("x\u{0}y 🦀");
    assert_eq!(
        call_json(knext_ffi_v1_echo_opt_string_5e5cc696, &s),
        (OK, s.clone())
    );

    let v = json!(["-9223372036854775808", "0", "9223372036854775807"]);
    assert_eq!(
        call_json(knext_ffi_v1_echo_vec_i64_aa288515, &v),
        (OK, v.clone())
    );
    let v = json!(["18446744073709551615", "9007199254740993"]);
    assert_eq!(
        call_json(knext_ffi_v1_echo_vec_usize_80167490, &v),
        (OK, v.clone())
    );
    let v = json!([]);
    assert_eq!(
        call_json(knext_ffi_v1_echo_vec_i64_aa288515, &v),
        (OK, v.clone())
    );
    let v = json!(["", "a", "日本"]);
    assert_eq!(
        call_json(knext_ffi_v1_echo_vec_string_4f1b32f7, &v),
        (OK, v.clone())
    );
    let v = json!([point("one"), point("two")]);
    assert_eq!(
        call_json(knext_ffi_v1_echo_vec_point_e1008be8, &v),
        (OK, v.clone())
    );
}

// ---- floats inside JSON: finite only, in every position --------------------------------

fn message(out: Out) -> String {
    String::from_utf8(take(out)).unwrap()
}

#[test]
fn finite_floats_in_option_and_vec_positions_round_trip() {
    for v in [json!(1.5), json!(-0.25), json!(null), json!(1e300)] {
        assert_eq!(
            call_json(knext_ffi_v1_echo_opt_f64_9c485b99, &v),
            (OK, v.clone())
        );
    }
    let r = json!({"value": 2.5, "samples": [0.5, null, -3.0]});
    assert_eq!(
        call_json(knext_ffi_v1_echo_reading_d3285823, &r),
        (OK, r.clone())
    );
    let r = json!({"value": null, "samples": []});
    assert_eq!(
        call_json(knext_ffi_v1_echo_reading_d3285823, &r),
        (OK, r.clone())
    );
}

#[test]
fn a_non_finite_float_in_an_option_return_is_status_3_naming_the_path_never_null() {
    for (which, shown) in [(0u8, "NaN"), (1, "Infinity"), (2, "-Infinity")] {
        let (st, out) = call!(knext_ffi_v1_non_finite_opt_6e51ec3c(which));
        assert_eq!(
            (st, message(out)),
            (
                INVALID,
                format!(
                    "knext-ffi: the return value cannot cross as JSON: result: f64 {shown} is not finite (JSON has no NaN or Infinity)"
                )
            )
        );
    }
    let (st, out) = call!(knext_ffi_v1_non_finite_reading_4c875def());
    assert_eq!(
        (st, message(out)),
        (
            INVALID,
            "knext-ffi: the return value cannot cross as JSON: result.samples[2]: f32 NaN is not finite (JSON has no NaN or Infinity)"
                .to_string()
        )
    );
    // The process is fine and the next call works.
    let v = json!(0.5);
    assert_eq!(
        call_json(knext_ffi_v1_echo_opt_f64_9c485b99, &v),
        (OK, v.clone())
    );
}

#[test]
fn a_float_argument_that_does_not_fit_is_status_3_never_infinity() {
    // 1e300 is a finite f64 but overflows f32: refused, not read as +Infinity.
    for r in [
        json!({"value": null, "samples": [1e300]}),
        json!({"value": null, "samples": [null, -1e300]}),
    ] {
        let (st, msg) = call_json(knext_ffi_v1_echo_reading_d3285823, &r);
        assert_eq!(st, INVALID, "{r} -> {msg}");
        let msg = msg.as_str().unwrap();
        assert!(msg.contains("`r`"), "{msg}");
        assert!(msg.contains("does not fit a finite f32"), "{msg}");
    }
    // JSON text cannot spell NaN or Infinity at all.
    for bad in [&b"NaN"[..], b"Infinity", b"-Infinity", b"1e999"] {
        let (st, _) = call_str(knext_ffi_v1_echo_opt_f64_9c485b99, bad);
        assert_eq!(st, INVALID, "{}", String::from_utf8_lossy(bad));
    }
}

// ---- Result ---------------------------------------------------------------------------

#[test]
fn result_ok_is_status_0_and_err_is_status_1_with_display() {
    let (st, out) = call_str(knext_ffi_v1_parse_i32_c4cfc8ac, b"42");
    assert_eq!((st, scalar::<i32>(&out)), (OK, 42));
    let (st, out) = call_str(knext_ffi_v1_parse_i32_c4cfc8ac, b"x");
    assert_eq!(st, ERR);
    assert_eq!(
        take_string(out),
        "invalid digit found in string",
        "e.to_string()"
    );

    let (st, out) = call!(knext_ffi_v1_fallible_unit_bfc26025(false));
    assert_eq!((st, out), (OK, [0, 0]));
    let (st, out) = call!(knext_ffi_v1_fallible_unit_bfc26025(true));
    assert_eq!(
        (st, take_string(out)),
        (ERR, "failed on purpose".to_string())
    );

    let p = serde_json::to_vec(&point("pp")).unwrap();
    let mut out: Out = [0, 0];
    let st = unsafe { knext_ffi_v1_fallible_point_480ebe3f(true, p.as_ptr(), p.len(), &mut out) };
    assert_eq!((st, take_string(out)), (ERR, "no point for pp".to_string()));
    let mut out: Out = [0, 0];
    let st = unsafe { knext_ffi_v1_fallible_point_480ebe3f(false, p.as_ptr(), p.len(), &mut out) };
    assert_eq!(st, OK);
    let back: Value = serde_json::from_slice(&take(out)).unwrap();
    assert_eq!(back, point("pp"));
}

// ---- panics ------------------------------------------------------------------------------

#[test]
fn panic_is_status_2_with_the_message_and_the_next_call_works() {
    let (st, out) = call_str(knext_ffi_v1_boom_c713b06c, "boom from rust ✨".as_bytes());
    assert_eq!(
        (st, take_string(out)),
        (PANIC, "boom from rust ✨".to_string())
    );
    let (st, out) = call!(knext_ffi_v1_add_43c960c6(1, 2));
    assert_eq!((st, scalar::<i32>(&out)), (OK, 3), "the next call succeeds");

    let (st, out) = call!(knext_ffi_v1_boom_static_d517f329());
    assert_eq!((st, take_string(out)), (PANIC, "static boom".to_string()));
    let (st, out) = call!(knext_ffi_v1_boom_any_a38fce13());
    assert_eq!(
        (st, take_string(out)),
        (PANIC, "panic with a non-string payload".to_string())
    );
}

#[test]
fn a_thousand_panics_in_a_row() {
    for i in 0..1000 {
        let msg = format!("boom {i}");
        let (st, out) = call_str(knext_ffi_v1_boom_c713b06c, msg.as_bytes());
        assert_eq!((st, take_string(out)), (PANIC, msg));
    }
    let (st, out) = call_str(knext_ffi_v1_greet_8a119d0c, b"after");
    assert_eq!((st, take_string(out)), (OK, "Hello, after!".to_string()));
}
