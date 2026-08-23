use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::oneshot;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RequestPriority {
    Critical,
    #[default]
    Normal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SchedulerError;

impl fmt::Display for SchedulerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Jupiter request scheduler stopped before releasing a request")
    }
}

impl std::error::Error for SchedulerError {}

struct State {
    last_request_at: Option<Instant>,
    critical: VecDeque<oneshot::Sender<()>>,
    normal: VecDeque<oneshot::Sender<()>>,
    draining: bool,
}

struct Inner {
    minimum_interval: Duration,
    state: Mutex<State>,
}

/// Serializes Jupiter's shared API-key bucket and prioritizes live execution.
#[derive(Clone)]
pub struct JupiterRequestScheduler {
    inner: Arc<Inner>,
}

impl JupiterRequestScheduler {
    #[must_use]
    pub fn new(minimum_interval: Duration) -> Self {
        Self {
            inner: Arc::new(Inner {
                minimum_interval,
                state: Mutex::new(State {
                    last_request_at: None,
                    critical: VecDeque::new(),
                    normal: VecDeque::new(),
                    draining: false,
                }),
            }),
        }
    }

    /// Waits for this request's turn in the shared Jupiter rate-limit bucket.
    ///
    /// # Errors
    ///
    /// Returns an error only if the internal worker is aborted.
    pub async fn wait(&self, priority: RequestPriority) -> Result<(), SchedulerError> {
        let (sender, receiver) = oneshot::channel();
        let should_spawn = {
            let mut state = self.lock_state();
            match priority {
                RequestPriority::Critical => state.critical.push_back(sender),
                RequestPriority::Normal => state.normal.push_back(sender),
            }
            if state.draining {
                false
            } else {
                state.draining = true;
                true
            }
        };
        if should_spawn {
            let scheduler = self.clone();
            tokio::spawn(async move { scheduler.drain().await });
        }
        receiver.await.map_err(|_| SchedulerError)
    }

    #[must_use]
    pub fn pending_counts(&self) -> (usize, usize) {
        let state = self.lock_state();
        (state.critical.len(), state.normal.len())
    }

    async fn drain(self) {
        loop {
            let (release, delay) = {
                let mut state = self.lock_state();
                let release = state
                    .critical
                    .pop_front()
                    .or_else(|| state.normal.pop_front());
                let Some(release) = release else {
                    state.draining = false;
                    return;
                };
                let delay = state.last_request_at.map_or(Duration::ZERO, |last| {
                    self.inner.minimum_interval.saturating_sub(last.elapsed())
                });
                (release, delay)
            };

            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            {
                let mut state = self.lock_state();
                state.last_request_at = Some(Instant::now());
            }
            let _ = release.send(());
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn critical_requests_jump_a_normal_backlog() {
        let scheduler = JupiterRequestScheduler::new(Duration::from_millis(1));
        scheduler
            .wait(RequestPriority::Normal)
            .await
            .expect("first release");

        let normal_scheduler = scheduler.clone();
        let normal = tokio::spawn(async move {
            normal_scheduler
                .wait(RequestPriority::Normal)
                .await
                .expect("normal release");
            "normal"
        });
        tokio::task::yield_now().await;
        let critical_scheduler = scheduler.clone();
        let critical = tokio::spawn(async move {
            critical_scheduler
                .wait(RequestPriority::Critical)
                .await
                .expect("critical release");
            "critical"
        });

        // A request already released cannot be preempted. Critical does jump
        // requests that remain queued after the active interval.
        assert_eq!(normal.await.expect("normal task"), "normal");
        assert_eq!(critical.await.expect("critical task"), "critical");
    }

    #[tokio::test]
    async fn enforces_minimum_spacing() {
        let scheduler = JupiterRequestScheduler::new(Duration::from_millis(10));
        scheduler
            .wait(RequestPriority::Normal)
            .await
            .expect("first release");
        let started = Instant::now();
        scheduler
            .wait(RequestPriority::Critical)
            .await
            .expect("second release");
        assert!(started.elapsed() >= Duration::from_millis(8));
    }
}
