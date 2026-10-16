//! Request-body bounds, and the response body that marks a call in flight.

use std::error::Error;
use std::fmt;
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Duration;

use bytes::Bytes;
use http::Request;
use http_body::{Body, Frame, SizeHint};
use pin_project_lite::pin_project;
use tokio::time::{Sleep, sleep};

/// Why a request body was cut off.
#[derive(Debug)]
pub enum BodyError {
    /// The body ran past the byte cap.
    TooLarge { limit: usize },
    /// The body did not arrive within the read timeout.
    TimedOut { after: Duration },
    /// Reading the body failed.
    Read(Box<dyn Error + Send + Sync>),
}

impl fmt::Display for BodyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } => write!(f, "request body is larger than {limit} bytes"),
            Self::TimedOut { after } => write!(f, "request body did not arrive within {after:?}"),
            Self::Read(err) => write!(f, "reading the request body: {err}"),
        }
    }
}

impl Error for BodyError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Read(err) => Some(err.as_ref()),
            _ => None,
        }
    }
}

pin_project! {
    /// A request body cut off once it has delivered more than `limit` bytes,
    /// or once `timeout` has passed since the request arrived, whichever is
    /// first. After the body has ended, neither applies: the call may run
    /// longer than the read timeout.
    pub struct BoundedBody<B> {
        #[pin]
        inner: B,
        #[pin]
        deadline: Sleep,
        timeout: Duration,
        limit: usize,
        read: usize,
        done: bool,
    }
}

impl<B> BoundedBody<B> {
    pub fn new(inner: B, limit: usize, timeout: Duration) -> Self {
        Self {
            inner,
            deadline: sleep(timeout),
            timeout,
            limit,
            read: 0,
            done: false,
        }
    }
}

impl<B> Body for BoundedBody<B>
where
    B: Body<Data = Bytes>,
    B::Error: Into<Box<dyn Error + Send + Sync>>,
{
    type Data = Bytes;
    type Error = BodyError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, BodyError>>> {
        let this = self.project();
        if *this.done {
            return Poll::Ready(None);
        }
        if this.deadline.poll(cx).is_ready() {
            *this.done = true;
            return Poll::Ready(Some(Err(BodyError::TimedOut {
                after: *this.timeout,
            })));
        }
        match ready!(this.inner.poll_frame(cx)) {
            Some(Ok(frame)) => {
                if let Some(data) = frame.data_ref() {
                    *this.read = this.read.saturating_add(data.len());
                    if *this.read > *this.limit {
                        *this.done = true;
                        return Poll::Ready(Some(Err(BodyError::TooLarge { limit: *this.limit })));
                    }
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Some(Err(err)) => {
                *this.done = true;
                Poll::Ready(Some(Err(BodyError::Read(err.into()))))
            }
            None => {
                *this.done = true;
                Poll::Ready(None)
            }
        }
    }

    fn is_end_stream(&self) -> bool {
        self.done || self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Wraps every request body in a [`BoundedBody`].
#[derive(Debug, Clone, Copy)]
pub struct BoundedBodyLayer {
    limit: usize,
    timeout: Duration,
}

impl BoundedBodyLayer {
    pub fn new(limit: usize, timeout: Duration) -> Self {
        Self { limit, timeout }
    }
}

impl<S> tower::Layer<S> for BoundedBodyLayer {
    type Service = BoundedBodyService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        BoundedBodyService {
            inner,
            layer: *self,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BoundedBodyService<S> {
    inner: S,
    layer: BoundedBodyLayer,
}

impl<S, B> tower::Service<Request<B>> for BoundedBodyService<S>
where
    S: tower::Service<Request<BoundedBody<B>>>,
{
    type Response = S::Response;
    type Error = S::Error;
    type Future = S::Future;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<B>) -> Self::Future {
        let (limit, timeout) = (self.layer.limit, self.layer.timeout);
        self.inner
            .call(req.map(|body| BoundedBody::new(body, limit, timeout)))
    }
}

pin_project! {
    /// A response body that holds `guard` until it is dropped.
    pub struct Guarded<B, G> {
        #[pin]
        inner: B,
        guard: G,
    }
}

impl<B, G> Guarded<B, G> {
    pub fn new(inner: B, guard: G) -> Self {
        Self { inner, guard }
    }
}

impl<B: Body, G> Body for Guarded<B, G> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<B::Data>, B::Error>>> {
        self.project().inner.poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}
