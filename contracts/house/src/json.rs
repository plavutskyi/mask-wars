//! The little JSON the house reads and writes: one flat object whose values are strings, whole numbers or lists of
//! strings. Strings are printable ASCII without escapes: every value the house takes (account ids, round ids, hashes,
//! amounts) is one, and anything else is refused, never guessed at.

use alloc::string::String;
use alloc::vec::Vec;

#[derive(Debug, PartialEq)]
pub enum Value<'a> {
    Str(&'a str),
    /// A whole number, its digits as written.
    Num(&'a str),
    List(Vec<&'a str>),
}

/// The fields of one object, in order, each key once.
#[derive(Debug, PartialEq)]
pub struct Object<'a> {
    pub fields: Vec<(&'a str, Value<'a>)>,
}

struct Reader<'a> {
    s: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn ws(&mut self) {
        while self.at < self.s.len() && matches!(self.s[self.at], b' ' | b'\n' | b'\r' | b'\t') {
            self.at += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.at).copied()
    }

    fn eat(&mut self, b: u8) -> Result<(), &'static str> {
        self.ws();
        if self.peek() == Some(b) {
            self.at += 1;
            Ok(())
        } else {
            Err("arguments: not the JSON the house reads")
        }
    }

    fn string(&mut self) -> Result<&'a str, &'static str> {
        self.eat(b'"')?;
        let start = self.at;
        while let Some(b) = self.peek() {
            match b {
                b'"' => {
                    let text = &self.s[start..self.at];
                    self.at += 1;
                    // Printable ASCII only, checked below: always UTF-8.
                    return core::str::from_utf8(text).map_err(|_| "arguments: text is ASCII");
                }
                0x20..=0x7e if b != b'\\' => self.at += 1,
                _ => return Err("arguments: text is printable ASCII, with no escapes"),
            }
        }
        Err("arguments: a string never ends")
    }

    fn number(&mut self) -> Result<&'a str, &'static str> {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        let digits = &self.s[start..self.at];
        if digits.is_empty() || (digits.len() > 1 && digits[0] == b'0') {
            return Err("arguments: a number is whole, with no leading zero");
        }
        core::str::from_utf8(digits).map_err(|_| "arguments: digits")
    }

    fn value(&mut self) -> Result<Value<'a>, &'static str> {
        self.ws();
        match self.peek() {
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b'0'..=b'9') => Ok(Value::Num(self.number()?)),
            Some(b'[') => {
                self.at += 1;
                let mut list = Vec::new();
                self.ws();
                if self.peek() == Some(b']') {
                    self.at += 1;
                    return Ok(Value::List(list));
                }
                loop {
                    list.push(self.string()?);
                    self.ws();
                    match self.peek() {
                        Some(b',') => self.at += 1,
                        Some(b']') => {
                            self.at += 1;
                            return Ok(Value::List(list));
                        }
                        _ => return Err("arguments: a list of strings"),
                    }
                }
            }
            _ => Err("arguments: values are strings, whole numbers or lists of strings"),
        }
    }
}

/// Reads one object. Empty input reads as `{}`.
pub fn parse(input: &[u8]) -> Result<Object<'_>, &'static str> {
    let mut r = Reader { s: input, at: 0 };
    r.ws();
    if r.at == input.len() {
        return Ok(Object { fields: Vec::new() });
    }
    r.eat(b'{')?;
    let mut fields: Vec<(&str, Value)> = Vec::new();
    r.ws();
    if r.peek() == Some(b'}') {
        r.at += 1;
    } else {
        loop {
            let key = r.string()?;
            if fields.iter().any(|(k, _)| *k == key) {
                return Err("arguments: each field once");
            }
            r.eat(b':')?;
            let value = r.value()?;
            fields.push((key, value));
            r.ws();
            match r.peek() {
                Some(b',') => r.at += 1,
                Some(b'}') => {
                    r.at += 1;
                    break;
                }
                _ => return Err("arguments: not the JSON the house reads"),
            }
        }
    }
    r.ws();
    if r.at != input.len() {
        return Err("arguments: one object and nothing after it");
    }
    Ok(Object { fields })
}

impl<'a> Object<'a> {
    pub fn get(&self, key: &str) -> Option<&Value<'a>> {
        self.fields.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    /// Refuses any field not in `known`: a typo in the terms is an error, never a default.
    pub fn only(&self, known: &[&str]) -> Result<(), &'static str> {
        if self.fields.iter().all(|(k, _)| known.contains(k)) {
            Ok(())
        } else {
            Err("arguments: a field the house does not know")
        }
    }

    pub fn str(&self, key: &str) -> Result<&'a str, &'static str> {
        match self.get(key) {
            Some(Value::Str(s)) => Ok(s),
            Some(_) => Err("arguments: a field is not a string"),
            None => Err("arguments: a field is missing"),
        }
    }

    pub fn list(&self, key: &str) -> Result<&[&'a str], &'static str> {
        match self.get(key) {
            Some(Value::List(l)) => Ok(l),
            Some(_) => Err("arguments: a field is not a list"),
            None => Err("arguments: a field is missing"),
        }
    }

    /// A whole number written as a number or as a string of digits (`U64`, `U128`).
    pub fn digits(&self, key: &str) -> Result<&'a str, &'static str> {
        match self.get(key) {
            Some(Value::Num(d)) => Ok(d),
            Some(Value::Str(s)) if is_number(s) => Ok(s),
            Some(_) => Err("arguments: a field is not a whole number"),
            None => Err("arguments: a field is missing"),
        }
    }

    pub fn u128(&self, key: &str) -> Result<u128, &'static str> {
        to_u128(self.digits(key)?)
    }

    pub fn u64(&self, key: &str) -> Result<u64, &'static str> {
        u64::try_from(self.u128(key)?).map_err(|_| "arguments: a number is too big")
    }

    pub fn u32(&self, key: &str) -> Result<u32, &'static str> {
        u32::try_from(self.u128(key)?).map_err(|_| "arguments: a number is too big")
    }
}

fn is_number(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) && !(s.len() > 1 && s.starts_with('0'))
}

pub fn to_u128(digits: &str) -> Result<u128, &'static str> {
    if !is_number(digits) {
        return Err("arguments: a whole number");
    }
    let mut n: u128 = 0;
    for b in digits.bytes() {
        n = n
            .checked_mul(10)
            .and_then(|n| n.checked_add(u128::from(b - b'0')))
            .ok_or("arguments: a number is too big")?;
    }
    Ok(n)
}

/// A whole number in decimal.
pub fn decimal(mut n: u128) -> String {
    let mut digits = [0u8; 39];
    let mut i = digits.len();
    loop {
        i -= 1;
        digits[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    // Digits only: always UTF-8.
    String::from(core::str::from_utf8(&digits[i..]).unwrap_or("0"))
}

/// Writes an object field by field. Every value the house writes is checked printable ASCII without quotes or
/// backslashes before it gets here, so it goes in as it is.
pub struct Writer {
    out: String,
}

impl Writer {
    pub fn new() -> Self {
        Writer { out: String::from("{") }
    }

    fn key(&mut self, key: &str) {
        if self.out.len() > 1 {
            self.out.push(',');
        }
        self.out.push('"');
        self.out.push_str(key);
        self.out.push_str("\":");
    }

    pub fn str(mut self, key: &str, value: &str) -> Self {
        self.key(key);
        self.out.push('"');
        self.out.push_str(value);
        self.out.push('"');
        self
    }

    /// A number as a string, as near-sdk writes `U64` and `U128`.
    pub fn big(self, key: &str, value: u128) -> Self {
        let text = decimal(value);
        self.str(key, &text)
    }

    pub fn num(mut self, key: &str, value: u128) -> Self {
        self.key(key);
        self.out.push_str(&decimal(value));
        self
    }

    pub fn bool(mut self, key: &str, value: bool) -> Self {
        self.key(key);
        self.out.push_str(if value { "true" } else { "false" });
        self
    }

    pub fn null(mut self, key: &str) -> Self {
        self.key(key);
        self.out.push_str("null");
        self
    }

    pub fn list(mut self, key: &str, values: &[String]) -> Self {
        self.key(key);
        self.out.push('[');
        for (i, v) in values.iter().enumerate() {
            if i > 0 {
                self.out.push(',');
            }
            self.out.push('"');
            self.out.push_str(v);
            self.out.push('"');
        }
        self.out.push(']');
        self
    }

    pub fn done(mut self) -> String {
        self.out.push('}');
        self.out
    }
}

impl Default for Writer {
    fn default() -> Self {
        Self::new()
    }
}
