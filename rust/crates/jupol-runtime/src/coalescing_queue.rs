use std::collections::VecDeque;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::Notify;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueueCapacityError;

impl fmt::Display for QueueCapacityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Async queue capacity must be a positive integer")
    }
}

impl std::error::Error for QueueCapacityError {}

struct PendingItem<T, K> {
    item: T,
    key: Option<K>,
}

struct Inner<T, K, F> {
    capacity: usize,
    coalesce_key: F,
    items: Mutex<VecDeque<PendingItem<T, K>>>,
    available: Notify,
}

/// A bounded single-consumer queue that replaces obsolete pending snapshots.
pub struct CoalescingAsyncQueue<T, K, F> {
    inner: Arc<Inner<T, K, F>>,
}

impl<T, K, F> Clone for CoalescingAsyncQueue<T, K, F> {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<T, K, F> CoalescingAsyncQueue<T, K, F>
where
    K: Eq,
    F: Fn(&T) -> Option<K>,
{
    /// Creates a bounded queue.
    ///
    /// # Errors
    ///
    /// Returns an error when `capacity` is zero.
    pub fn new(capacity: usize, coalesce_key: F) -> Result<Self, QueueCapacityError> {
        if capacity == 0 {
            return Err(QueueCapacityError);
        }
        Ok(Self {
            inner: Arc::new(Inner {
                capacity,
                coalesce_key,
                items: Mutex::new(VecDeque::with_capacity(capacity)),
                available: Notify::new(),
            }),
        })
    }

    #[must_use]
    pub fn pending_count(&self) -> usize {
        self.lock_items().len()
    }

    pub fn push(&self, item: T) {
        let key = (self.inner.coalesce_key)(&item);
        let mut items = self.lock_items();
        if let Some(ref key_value) = key
            && let Some(existing) = items
                .iter_mut()
                .find(|pending| pending.key.as_ref() == Some(key_value))
        {
            *existing = PendingItem { item, key };
            return;
        }

        if items.len() >= self.inner.capacity {
            let obsolete = items.iter().position(|pending| pending.key.is_some());
            items.remove(obsolete.unwrap_or(0));
        }
        items.push_back(PendingItem { item, key });
        drop(items);
        self.inner.available.notify_one();
    }

    pub async fn next(&self) -> T {
        loop {
            // Register before checking to avoid a notification race between an
            // empty check and awaiting the notification.
            let notified = self.inner.available.notified();
            if let Some(pending) = self.lock_items().pop_front() {
                return pending.item;
            }
            notified.await;
        }
    }

    fn lock_items(&self) -> MutexGuard<'_, VecDeque<PendingItem<T, K>>> {
        self.inner
            .items
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Eq, PartialEq)]
    enum Event {
        Snapshot(&'static str, u64),
        Control(u64),
    }

    #[tokio::test]
    async fn replaces_obsolete_snapshots_without_reordering_controls() {
        let queue = CoalescingAsyncQueue::new(4, |event: &Event| match event {
            Event::Snapshot(market, _) => Some(*market),
            Event::Control(_) => None,
        })
        .expect("valid capacity");
        queue.push(Event::Control(1));
        queue.push(Event::Snapshot("btc-5m", 1));
        queue.push(Event::Snapshot("btc-5m", 2));
        queue.push(Event::Control(2));

        assert_eq!(queue.pending_count(), 3);
        assert_eq!(queue.next().await, Event::Control(1));
        assert_eq!(queue.next().await, Event::Snapshot("btc-5m", 2));
        assert_eq!(queue.next().await, Event::Control(2));
    }

    #[tokio::test]
    async fn evicts_snapshot_before_control_when_full() {
        let queue = CoalescingAsyncQueue::new(2, |event: &Event| match event {
            Event::Snapshot(market, _) => Some(*market),
            Event::Control(_) => None,
        })
        .expect("valid capacity");
        queue.push(Event::Control(1));
        queue.push(Event::Snapshot("btc-5m", 1));
        queue.push(Event::Control(2));
        assert_eq!(queue.next().await, Event::Control(1));
        assert_eq!(queue.next().await, Event::Control(2));
    }
}
