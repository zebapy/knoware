//! Shared app state plus the helpers that mutate it and tell the renderer.

use crate::agent::AgentHandle;
use crate::world::{self, Blob, Settings, World};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// One row of a session's transcript, as the session panel draws it.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    User {
        text: String,
    },
    Agent {
        text: String,
    },
    Thought {
        text: String,
    },
    Tool {
        id: String,
        title: String,
        status: String,
    },
    Plan {
        items: Vec<PlanItem>,
    },
    Notice {
        text: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub content: String,
    pub status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EntryEvent<'a> {
    blob_id: &'a str,
    index: usize,
    entry: &'a Entry,
}

pub struct App {
    pub handle: AppHandle,
    pub settings: Settings,
    pub world: Mutex<World>,
    pub agents: Mutex<HashMap<String, AgentHandle>>,
    pub transcripts: Mutex<HashMap<String, Vec<Entry>>>,
}

pub type Shared = Arc<App>;

impl App {
    pub fn new(handle: AppHandle) -> Self {
        Self {
            handle,
            settings: world::load_settings(),
            world: Mutex::new(world::load_world()),
            agents: Mutex::new(HashMap::new()),
            transcripts: Mutex::new(HashMap::new()),
        }
    }

    pub fn snapshot(&self) -> World {
        self.world.lock().unwrap().clone()
    }

    /// Structural change (planets, moons, blobs added or removed): persist and resend everything.
    pub fn world_changed(&self) {
        let world = self.snapshot();
        let _ = world::save_world(&world);
        let _ = self.handle.emit("world", &world);
    }

    /// Change one blob and send just that blob. Returns false when the blob is gone.
    pub fn update_blob(&self, id: &str, persist: bool, f: impl FnOnce(&mut Blob)) -> bool {
        let (blob, world) = {
            let mut world = self.world.lock().unwrap();
            let Some(blob) = world.blob_mut(id) else {
                return false;
            };
            f(blob);
            (blob.clone(), persist.then(|| world.clone()))
        };
        if let Some(world) = world {
            let _ = world::save_world(&world);
        }
        let _ = self.handle.emit("blob", &blob);
        true
    }

    pub fn blob(&self, id: &str) -> Option<Blob> {
        self.world.lock().unwrap().blob(id).cloned()
    }

    /// Change the transcript's last entry when `merge` accepts it, else append `fresh`.
    pub fn push_entry(&self, blob_id: &str, fresh: Entry, merge: impl FnOnce(&mut Entry) -> bool) {
        let mut all = self.transcripts.lock().unwrap();
        let list = all.entry(blob_id.to_string()).or_default();
        let merged = list.last_mut().is_some_and(merge);
        if !merged {
            list.push(fresh);
        }
        let index = list.len() - 1;
        let _ = self.handle.emit(
            "entry",
            EntryEvent {
                blob_id,
                index,
                entry: &list[index],
            },
        );
    }

    /// Change an earlier entry in place, found by `find`.
    pub fn edit_entry(
        &self,
        blob_id: &str,
        find: impl Fn(&Entry) -> bool,
        f: impl FnOnce(&mut Entry),
    ) {
        let mut all = self.transcripts.lock().unwrap();
        let Some(list) = all.get_mut(blob_id) else {
            return;
        };
        let Some(index) = list.iter().rposition(find) else {
            return;
        };
        f(&mut list[index]);
        let _ = self.handle.emit(
            "entry",
            EntryEvent {
                blob_id,
                index,
                entry: &list[index],
            },
        );
    }

    pub fn notice(&self, blob_id: &str, text: impl Into<String>) {
        self.push_entry(blob_id, Entry::Notice { text: text.into() }, |_| false);
    }

    pub fn transcript(&self, blob_id: &str) -> Vec<Entry> {
        self.transcripts
            .lock()
            .unwrap()
            .get(blob_id)
            .cloned()
            .unwrap_or_default()
    }
}
