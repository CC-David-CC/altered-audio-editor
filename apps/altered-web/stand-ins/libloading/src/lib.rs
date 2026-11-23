// SPDX-License-Identifier: GPL-3.0-or-later
//! `Library::new` always fails: there are no plug-ins in a browser.
use std::ffi::OsStr;
use std::marker::PhantomData;

#[derive(Debug)]
pub struct Error;

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("plug-ins can't load in a browser")
    }
}

impl std::error::Error for Error {}

pub struct Library;

impl Library {
    /// # Safety
    /// None needed: it never loads anything.
    pub unsafe fn new<P: AsRef<OsStr>>(_path: P) -> Result<Library, Error> {
        Err(Error)
    }
    /// # Safety
    /// None needed: no library ever opens.
    pub unsafe fn get<T>(&self, _symbol: &[u8]) -> Result<Symbol<'_, T>, Error> {
        Err(Error)
    }
}

pub struct Symbol<'lib, T>(T, PhantomData<&'lib ()>);

impl<T> std::ops::Deref for Symbol<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.0
    }
}
