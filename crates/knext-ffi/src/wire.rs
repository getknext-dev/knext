//! The JSON wire format of record fields and top-level JSON arguments and
//! returns (README, "Records and JSON"; ADR-0069 D7).
//!
//! Every 64-bit integer (`i64`, `u64`, `isize`, `usize`) in any JSON position
//! travels as a **decimal string**; a JSON number there is refused. Everything
//! else is plain serde_json: integers up to 32 bits and floats are numbers,
//! `bool` is a boolean, `String` a string, `Option<T>` is `T | null`,
//! `Vec<T>` an array (a `Vec<u8>` inside JSON is an array of numbers),
//! records are objects with their field names verbatim, unit enums are their
//! variant name. Floats must be finite in EVERY position, `Option` included:
//! JSON has no NaN or Infinity, and the `null` serde_json would write instead
//! reads back as `None`. Serializing one is an error naming its path
//! (`result.samples[2]: f32 NaN is not finite …`), which the shim returns as
//! status 3; a number that does not fit a finite `f32` is refused on the way in.
//!
//! `#[knext_ffi::record]` serializes every field through [`Field`] (its
//! [`Wire`] impl, with the field name on an error) and deserializes it with
//! [`deserialize`], and the export macro applies the same [`Wire`] impls to
//! top-level JSON arguments and returns, so the encoding is per position and
//! identical everywhere.

use serde::de::{Deserialize, Deserializer, Error as _};
use serde::ser::{Error as _, SerializeSeq, Serializer};
use std::fmt::Display;

/// A type that can cross the boundary inside JSON.
pub trait Wire: Sized {
    fn ser<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error>;
    fn de<'de, D: Deserializer<'de>>(d: D) -> Result<Self, D::Error>;
}

macro_rules! plain {
    ($($t:ty),*) => {$(
        impl Wire for $t {
            #[inline]
            fn ser<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                serde::Serialize::serialize(self, s)
            }
            #[inline]
            fn de<'de, D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                <$t as Deserialize<'de>>::deserialize(d)
            }
        }
    )*};
}
plain!(i8, i16, i32, u8, u16, u32, bool, String);

/// `NaN`, `Infinity`, `-Infinity`: the JavaScript spelling, as the caller sees it.
fn non_finite(v: f64) -> &'static str {
    if v.is_nan() {
        "NaN"
    } else if v > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

macro_rules! finite_float {
    ($($t:ident),*) => {$(
        impl Wire for $t {
            #[inline]
            fn ser<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                if self.is_finite() {
                    serde::Serialize::serialize(self, s)
                } else {
                    Err(S::Error::custom(format_args!(
                        "{} {} is not finite (JSON has no NaN or Infinity)",
                        stringify!($t),
                        non_finite(f64::from(*self))
                    )))
                }
            }
            #[inline]
            fn de<'de, D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let v = <$t as Deserialize<'de>>::deserialize(d)?;
                if v.is_finite() {
                    Ok(v)
                } else {
                    Err(D::Error::custom(format_args!(
                        "the number does not fit a finite {}",
                        stringify!($t)
                    )))
                }
            }
        }
    )*};
}
finite_float!(f32, f64);

/// Prefixes a serialization error with one path segment (`.field`, `[3]`,
/// `result`), so the message of a refused value names where it is.
#[doc(hidden)]
pub fn at<E: serde::ser::Error>(segment: impl Display, e: E) -> E {
    let rest = e.to_string();
    if rest.starts_with('.') || rest.starts_with('[') {
        E::custom(format_args!("{segment}{rest}"))
    } else {
        E::custom(format_args!("{segment}: {rest}"))
    }
}

/// One record field, serialized through its [`Wire`] impl with its name on
/// any error (what `#[knext_ffi::record]` emits for every field).
#[doc(hidden)]
pub struct Field<'a, T>(pub &'static str, pub &'a T);
impl<T: Wire> serde::Serialize for Field<'_, T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.1
            .ser(s)
            .map_err(|e| at(format_args!(".{}", self.0), e))
    }
}

macro_rules! decimal_string {
    ($($t:ty),*) => {$(
        impl Wire for $t {
            #[inline]
            fn ser<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.collect_str(self)
            }
            fn de<'de, D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let s = <std::borrow::Cow<'de, str> as Deserialize<'de>>::deserialize(d).map_err(|e| {
                    D::Error::custom(format_args!(
                        "a {} must be a decimal string in JSON ({e})",
                        stringify!($t)
                    ))
                })?;
                s.parse::<$t>().map_err(|e| {
                    D::Error::custom(format_args!("invalid {} {:?}: {e}", stringify!($t), s))
                })
            }
        }
    )*};
}
decimal_string!(i64, u64, isize, usize);

/// Serializes `&T` through its [`Wire`] impl.
pub struct Ser<'a, T>(pub &'a T);
impl<T: Wire> serde::Serialize for Ser<'_, T> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.0.ser(s)
    }
}

/// Deserializes a `T` through its [`Wire`] impl.
pub struct De<T>(pub T);
impl<'de, T: Wire> Deserialize<'de> for De<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        T::de(d).map(De)
    }
}

/// `None` is JSON `null`. The macros refuse an `Option` directly inside an
/// `Option` (at any position) because `Some(None)` would also be `null` and
/// could not survive the round trip; see `knext-ffi-macros` `types::classify`.
impl<T: Wire> Wire for Option<T> {
    fn ser<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Some(v) => s.serialize_some(&Ser(v)),
            None => s.serialize_none(),
        }
    }
    fn de<'de, D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(<Option<De<T>> as Deserialize<'de>>::deserialize(d)?.map(|v| v.0))
    }
}

impl<T: Wire> Wire for Vec<T> {
    fn ser<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut seq = s.serialize_seq(Some(self.len()))?;
        for (i, v) in self.iter().enumerate() {
            seq.serialize_element(&Ser(v))
                .map_err(|e| at(format_args!("[{i}]"), e))?;
        }
        seq.end()
    }
    fn de<'de, D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        Ok(<Vec<De<T>> as Deserialize<'de>>::deserialize(d)?
            .into_iter()
            .map(|v| v.0)
            .collect())
    }
}

/// `#[serde(serialize_with)]` half of `#[serde(with = "::knext_ffi::wire")]`.
pub fn serialize<T: Wire, S: Serializer>(v: &T, s: S) -> Result<S::Ok, S::Error> {
    v.ser(s)
}

/// `#[serde(deserialize_with)]` half of `#[serde(with = "::knext_ffi::wire")]`.
pub fn deserialize<'de, T: Wire, D: Deserializer<'de>>(d: D) -> Result<T, D::Error> {
    T::de(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to(v: &impl Wire) -> String {
        let mut buf = Vec::new();
        v.ser(&mut serde_json::Serializer::new(&mut buf)).unwrap();
        String::from_utf8(buf).unwrap()
    }
    fn from<T: Wire>(s: &str) -> Result<T, serde_json::Error> {
        let mut de = serde_json::Deserializer::from_str(s);
        T::de(&mut de)
    }

    #[test]
    fn sixty_four_bit_integers_are_decimal_strings_in_every_position() {
        assert_eq!(to(&u64::MAX), "\"18446744073709551615\"");
        assert_eq!(to(&i64::MIN), "\"-9223372036854775808\"");
        assert_eq!(to(&Some(9_007_199_254_740_993u64)), "\"9007199254740993\"");
        assert_eq!(to(&vec![Some(1i64), None]), "[\"1\",null]");
        assert_eq!(to(&vec![usize::MAX]), "[\"18446744073709551615\"]");
        assert_eq!(to(&Some(vec![-1isize])), "[\"-1\"]");
        assert_eq!(from::<u64>("\"18446744073709551615\"").unwrap(), u64::MAX);
        assert_eq!(
            from::<Vec<Option<i64>>>("[\"-5\",null]").unwrap(),
            vec![Some(-5), None]
        );
        assert!(from::<u64>("5").is_err(), "a JSON number is refused");
        assert!(from::<u64>("\"-1\"").is_err(), "out of range");
        assert!(
            from::<i64>("\"9223372036854775808\"").is_err(),
            "out of range"
        );
    }

    fn to_err(v: &impl Wire) -> String {
        let mut buf = Vec::new();
        v.ser(&mut serde_json::Serializer::new(&mut buf))
            .expect_err("a non-finite float must not serialize")
            .to_string()
    }

    #[test]
    fn small_integers_floats_and_bytes_stay_numbers() {
        assert_eq!(to(&u32::MAX), "4294967295");
        assert_eq!(to(&vec![0u8, 255]), "[0,255]");
        assert_eq!(to(&1.5f64), "1.5");
        assert_eq!(to(&Some(-0.25f32)), "-0.25");
        assert_eq!(to(&vec![Some(0.5f64), None]), "[0.5,null]");
        assert!(from::<f64>("null").is_err());
        assert_eq!(from::<Option<f64>>("null").unwrap(), None);
        assert_eq!(from::<f32>("3.5").unwrap(), 3.5);
        assert!(from::<u8>("256").is_err());
    }

    #[test]
    fn non_finite_floats_are_refused_in_every_position_naming_the_path() {
        const WHY: &str = "is not finite (JSON has no NaN or Infinity)";
        assert_eq!(to_err(&f64::NAN), format!("f64 NaN {WHY}"));
        assert_eq!(to_err(&f32::INFINITY), format!("f32 Infinity {WHY}"));
        // Inside an Option, where null would silently mean None.
        assert_eq!(
            to_err(&Some(f64::NEG_INFINITY)),
            format!("f64 -Infinity {WHY}")
        );
        assert_eq!(
            to_err(&vec![Some(1.0f32), None, Some(f32::NAN)]),
            format!("[2]: f32 NaN {WHY}")
        );
        assert_eq!(
            to_err(&Some(vec![vec![1.0f64], vec![2.0, f64::INFINITY]])),
            format!("[1][1]: f64 Infinity {WHY}")
        );
    }

    #[test]
    fn a_float_that_does_not_fit_is_refused_on_the_way_in() {
        // serde reads a JSON number into f32 with `as`, so 1e300 would be +Infinity.
        for bad in ["1e300", "-1e300"] {
            let e = from::<f32>(bad).unwrap_err().to_string();
            assert!(e.contains("does not fit a finite f32"), "{e}");
            assert!(from::<Option<f32>>(bad).is_err());
            assert!(from::<Vec<Option<f32>>>(&format!("[{bad}]")).is_err());
        }
        assert!(from::<f64>("1e999").is_err());
        assert_eq!(from::<f64>("1e300").unwrap(), 1e300);
    }
}
