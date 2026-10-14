//! The JSON wire format of record fields and top-level JSON arguments and
//! returns (README, "Records and JSON"; ADR-0069 D7).
//!
//! Every 64-bit integer (`i64`, `u64`, `isize`, `usize`) in any JSON position
//! travels as a **decimal string**; a JSON number there is refused. Everything
//! else is plain serde_json: integers up to 32 bits and floats are numbers,
//! `bool` is a boolean, `String` a string, `Option<T>` is `T | null`,
//! `Vec<T>` an array (a `Vec<u8>` inside JSON is an array of numbers),
//! records are objects with their field names verbatim, unit enums are their
//! variant name. A non-finite float serializes as `null` (JSON has no NaN);
//! the generated decoder refuses it.
//!
//! `#[knext_ffi::record]` applies [`serialize`]/[`deserialize`] to every field
//! (`#[serde(with = "::knext_ffi::wire")]`), and the export macro applies the
//! same [`Wire`] impls to top-level JSON arguments and returns, so the encoding
//! is per position and identical everywhere.

use serde::de::{Deserialize, Deserializer, Error as _};
use serde::ser::{SerializeSeq, Serializer};

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
plain!(i8, i16, i32, u8, u16, u32, f32, f64, bool, String);

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
        for v in self {
            seq.serialize_element(&Ser(v))?;
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

    #[test]
    fn small_integers_floats_and_bytes_stay_numbers() {
        assert_eq!(to(&u32::MAX), "4294967295");
        assert_eq!(to(&vec![0u8, 255]), "[0,255]");
        assert_eq!(to(&1.5f64), "1.5");
        assert_eq!(
            to(&f64::NAN),
            "null",
            "serde_json writes null; the decoder refuses it"
        );
        assert!(from::<f64>("null").is_err());
        assert!(from::<u8>("256").is_err());
    }
}
