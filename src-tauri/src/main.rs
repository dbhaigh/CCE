#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{Emitter, Manager, State};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::{
    MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};

const SLOTS: [&str; 4] = ["auto", "manual-1", "manual-2", "manual-3"];

#[derive(Default)]
struct SaveState(Mutex<HashMap<String, u64>>);

#[derive(serde::Serialize)]
struct LoadedSave {
    data: Option<String>,
    revision: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SlotInfo {
    slot: String,
    revision: u64,
    exists: bool,
    has_backup: bool,
    legacy: bool,
}

#[derive(Clone, serde::Serialize)]
struct SavedEvent<'a> {
    slot: &'a str,
    revision: u64,
}

#[derive(Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
struct SlotMetadata {
    revision: u64,
    deleted: bool,
}

#[tauri::command]
fn bridge_identity() -> &'static str {
    "com.dbhaigh.codecompilerempire"
}

fn validate_slot(slot: &str) -> Result<(), String> {
    if SLOTS.contains(&slot) {
        Ok(())
    } else {
        Err(format!("Unknown save slot: {slot}"))
    }
}

fn data_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate app data directory: {error}"))
}

fn primary_path(directory: &Path, slot: &str) -> PathBuf {
    directory.join(format!("empire-{slot}.json"))
}

fn backup_path(directory: &Path, slot: &str) -> PathBuf {
    directory.join(format!("empire-{slot}.backup.json"))
}

fn metadata_path(directory: &Path, slot: &str) -> PathBuf {
    directory.join(format!("empire-{slot}.meta.json"))
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(data) => Ok(Some(data)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

fn read_optional_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(data) => Ok(Some(data)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

fn read_metadata(directory: &Path, slot: &str) -> Result<SlotMetadata, String> {
    match read_optional(&metadata_path(directory, slot))? {
        Some(data) => serde_json::from_str(&data)
            .map_err(|error| format!("Cannot parse metadata for {slot}: {error}")),
        None => Ok(SlotMetadata::default()),
    }
}

fn current_revision(state: &mut HashMap<String, u64>, slot: &str, metadata: SlotMetadata) -> u64 {
    let latest = state.entry(slot.to_owned()).or_insert(0);
    *latest = (*latest).max(metadata.revision);
    *latest
}

fn load_from_directory(
    directory: &Path,
    slot: &str,
    backup: bool,
    state: &Mutex<HashMap<String, u64>>,
) -> Result<LoadedSave, String> {
    validate_slot(slot)?;
    let mut latest = state
        .lock()
        .map_err(|error| format!("Save lock poisoned: {error}"))?;
    let metadata = read_metadata(directory, slot)?;
    let revision = current_revision(&mut latest, slot, metadata);
    let data = if backup {
        read_optional(&backup_path(directory, slot))?
    } else {
        let modern = read_optional(&primary_path(directory, slot))?;
        if modern.is_some() || slot != "auto" || metadata.deleted {
            modern
        } else {
            read_optional(&directory.join("empire.json"))?
        }
    };
    Ok(LoadedSave { data, revision })
}

#[tauri::command]
fn load_slot(
    app: tauri::AppHandle,
    state: State<'_, SaveState>,
    slot: String,
    backup: bool,
) -> Result<LoadedSave, String> {
    load_from_directory(&data_directory(&app)?, &slot, backup, &state.0)
}

fn save_to_directory(
    directory: &Path,
    slot: &str,
    data: &str,
    revision: u64,
    state: &Mutex<HashMap<String, u64>>,
) -> Result<(), String> {
    validate_slot(slot)?;
    if !valid_save(data) {
        return Err(format!("Invalid save data for {slot}"));
    }
    let mut latest = state
        .lock()
        .map_err(|error| format!("Save lock poisoned: {error}"))?;
    let metadata = read_metadata(directory, slot)?;
    let previous = current_revision(&mut latest, slot, metadata);
    if revision <= previous {
        return Err(format!(
            "Stale save revision {revision} for {slot}; latest is {previous}"
        ));
    }
    fs::create_dir_all(directory)
        .map_err(|error| format!("Cannot create save directory: {error}"))?;

    let path = primary_path(directory, slot);
    let prior_data = read_optional_bytes(&path)?;
    let backup_candidate = if prior_data.is_none() && slot == "auto" && !metadata.deleted {
        read_optional_bytes(&directory.join("empire.json"))?
    } else {
        prior_data
    };
    if let Some(ref candidate) = backup_candidate {
        if std::str::from_utf8(candidate).is_ok_and(valid_save) {
            atomic_write(&backup_path(directory, slot), candidate, revision)?;
        }
    }

    // Commit the revision before the primary: a crash cannot make the new file look stale.
    let next = SlotMetadata {
        revision,
        deleted: metadata.deleted,
    };
    write_metadata(directory, slot, next)?;
    latest.insert(slot.to_owned(), revision);
    atomic_write(&path, data.as_bytes(), revision)?;
    if next.deleted {
        write_metadata(
            directory,
            slot,
            SlotMetadata {
                deleted: false,
                ..next
            },
        )?;
    }
    Ok(())
}

#[tauri::command]
fn save_slot(
    app: tauri::AppHandle,
    state: State<'_, SaveState>,
    slot: String,
    data: String,
    revision: u64,
) -> Result<(), String> {
    save_to_directory(&data_directory(&app)?, &slot, &data, revision, &state.0)?;
    app.emit(
        "game:saved",
        SavedEvent {
            slot: &slot,
            revision,
        },
    )
    .map_err(|error| format!("Save succeeded but notification failed: {error}"))
}

fn delete_from_directory(
    directory: &Path,
    slot: &str,
    state: &Mutex<HashMap<String, u64>>,
) -> Result<(), String> {
    validate_slot(slot)?;
    let mut latest = state
        .lock()
        .map_err(|error| format!("Save lock poisoned: {error}"))?;
    let metadata = read_metadata(directory, slot)?;
    let revision = current_revision(&mut latest, slot, metadata)
        .checked_add(1)
        .ok_or("Save revision overflow")?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("Cannot create save directory: {error}"))?;
    write_metadata(
        directory,
        slot,
        SlotMetadata {
            revision,
            deleted: true,
        },
    )?;
    latest.insert(slot.to_owned(), revision);
    remove_if_present(&primary_path(directory, slot))?;
    remove_if_present(&backup_path(directory, slot))
}

#[tauri::command]
fn delete_slot(
    app: tauri::AppHandle,
    state: State<'_, SaveState>,
    slot: String,
) -> Result<(), String> {
    delete_from_directory(&data_directory(&app)?, &slot, &state.0)
}

fn list_from_directory(
    directory: &Path,
    state: &Mutex<HashMap<String, u64>>,
) -> Result<Vec<SlotInfo>, String> {
    let mut latest = state
        .lock()
        .map_err(|error| format!("Save lock poisoned: {error}"))?;
    let mut slots = Vec::with_capacity(SLOTS.len());
    for slot in SLOTS {
        let metadata = read_metadata(directory, slot)?;
        let revision = current_revision(&mut latest, slot, metadata);
        let modern = file_exists(&primary_path(directory, slot))?;
        let legacy = slot == "auto"
            && !modern
            && !metadata.deleted
            && file_exists(&directory.join("empire.json"))?;
        slots.push(SlotInfo {
            slot: slot.to_owned(),
            revision,
            exists: modern || legacy,
            has_backup: file_exists(&backup_path(directory, slot))?,
            legacy,
        });
    }
    Ok(slots)
}

#[tauri::command]
fn list_slots(app: tauri::AppHandle, state: State<'_, SaveState>) -> Result<Vec<SlotInfo>, String> {
    list_from_directory(&data_directory(&app)?, &state.0)
}

fn write_metadata(directory: &Path, slot: &str, metadata: SlotMetadata) -> Result<(), String> {
    let data = serde_json::to_vec(&metadata)
        .map_err(|error| format!("Cannot serialize save metadata: {error}"))?;
    atomic_write(&metadata_path(directory, slot), &data, metadata.revision)
}

fn file_exists(path: &Path) -> Result<bool, String> {
    match fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Cannot inspect {}: {error}", path.display())),
    }
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove {}: {error}", path.display())),
    }
}

fn atomic_write(path: &Path, data: &[u8], revision: u64) -> Result<(), String> {
    let name = path
        .file_name()
        .ok_or("Save file has no name")?
        .to_string_lossy();
    let temporary = path.with_file_name(format!("{name}.{}.{}.tmp", std::process::id(), revision));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Cannot create temporary save: {error}"))?;

    let written = file
        .write_all(data)
        .map_err(|error| format!("Cannot write temporary save: {error}"))
        .and_then(|_| {
            file.sync_all()
                .map_err(|error| format!("Cannot sync temporary save: {error}"))
        });
    drop(file);
    let result = written.and_then(|_| replace_file(&temporary, path));
    if let Err(error) = result {
        return match fs::remove_file(&temporary) {
            Ok(()) => Err(error),
            Err(cleanup) if cleanup.kind() == ErrorKind::NotFound => Err(error),
            Err(cleanup) => Err(format!("{error}; cannot remove temporary save: {cleanup}")),
        };
    }
    Ok(())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), flags) } == 0 {
        return Err(format!(
            "Cannot atomically replace {}: {}",
            destination.display(),
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| {
        format!(
            "Cannot atomically replace {}: {error}",
            destination.display()
        )
    })?;
    let parent = destination
        .parent()
        .ok_or("Save file has no parent directory")?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Cannot sync save directory {}: {error}", parent.display()))
}

fn valid_save(data: &str) -> bool {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    let Some(object) = parsed.as_object() else {
        return false;
    };
    let snapshot = if let Some(format) = object.get("format") {
        if format.as_str() != Some("code-compiler-empire") {
            return false;
        }
        if safe_unsigned_integer(object.get("formatVersion")) != Some(1) {
            return false;
        }
        let Some(snapshot) = object.get("snapshot") else {
            return false;
        };
        let Some(checksum) = object.get("checksum").and_then(|value| value.as_str()) else {
            return false;
        };
        if content_hash(snapshot) != checksum {
            return false;
        }
        snapshot
    } else {
        &parsed
    };
    let Some(snapshot) = snapshot.as_object() else {
        return false;
    };
    let version = safe_unsigned_integer(snapshot.get("schemaVersion"));
    matches!(version, Some(1..=6))
        && ["tick", "scaledTimeRemainder", "wallClockSavedAt"]
            .iter()
            .all(|field| safe_nonnegative_integer(snapshot.get(*field)))
        && snapshot
            .get("tickDurationMs")
            .is_some_and(|value| safe_unsigned_integer(Some(value)).is_some_and(|n| n > 0))
        && (version == Some(1)
            || safe_unsigned_integer(snapshot.get("nextEventSequence")).is_some_and(|n| n > 0))
        && ["gameVersion", "contentHash", "seed"]
            .iter()
            .all(|field| snapshot.get(*field).is_some_and(|value| value.is_string()))
        && snapshot
            .get("resources")
            .and_then(|value| value.as_object())
            .is_some_and(|resources| resources.values().all(safe_signed_integer))
        && snapshot
            .get("systemStates")
            .is_some_and(|value| value.is_object())
        && snapshot
            .get("queuedCommands")
            .is_some_and(|value| value.is_array())
        && (version <= Some(2)
            || ["pendingEvents", "durableEvents"]
                .iter()
                .all(|field| snapshot.get(*field).is_some_and(|value| value.is_array())))
        && (version < Some(5)
            || snapshot
                .get("importantEvents")
                .is_some_and(|value| value.is_array()))
        && (version != Some(6)
            || snapshot
                .get("resources")
                .and_then(|value| value.get("core.demand"))
                .is_some_and(|value| {
                    safe_unsigned_integer(Some(value)).is_some_and(|n| n <= 2_000)
                }))
}

fn safe_nonnegative_integer(value: Option<&serde_json::Value>) -> bool {
    safe_unsigned_integer(value).is_some()
}

fn safe_unsigned_integer(value: Option<&serde_json::Value>) -> Option<u64> {
    let number = value?.as_f64()?;
    if number.is_finite()
        && (0.0..=9_007_199_254_740_991.0).contains(&number)
        && number.fract() == 0.0
    {
        Some(number as u64)
    } else {
        None
    }
}

fn safe_signed_integer(value: &serde_json::Value) -> bool {
    value.as_f64().is_some_and(|number| {
        number.is_finite() && number.abs() <= 9_007_199_254_740_991.0 && number.fract() == 0.0
    })
}

fn canonical_json(value: &serde_json::Value, output: &mut String) {
    match value {
        serde_json::Value::Object(object) => {
            output.push('{');
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).expect("JSON key"));
                output.push(':');
                canonical_json(&object[key], output);
            }
            output.push('}');
        }
        serde_json::Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                canonical_json(value, output);
            }
            output.push(']');
        }
        serde_json::Value::Number(number) => output.push_str(&javascript_number(number)),
        other => output.push_str(&serde_json::to_string(other).expect("JSON value")),
    }
}

fn javascript_number(number: &serde_json::Number) -> String {
    let serialized = number.to_string();
    let (negative, unsigned) = match serialized.strip_prefix('-') {
        Some(unsigned) => ("-", unsigned),
        None => ("", serialized.as_str()),
    };
    let (mantissa, exponent) = match unsigned.split_once(['e', 'E']) {
        Some((mantissa, exponent)) => (mantissa, exponent.parse::<i32>().unwrap_or(0)),
        None => (unsigned, 0),
    };
    let decimal = mantissa.find('.').unwrap_or(mantissa.len()) as i32;
    let raw_digits: String = mantissa.chars().filter(|digit| *digit != '.').collect();
    let leading = raw_digits
        .bytes()
        .take_while(|digit| *digit == b'0')
        .count();
    let digits = raw_digits[leading..].trim_end_matches('0');
    if digits.is_empty() {
        return "0".to_owned();
    }
    let decimal = decimal + exponent - leading as i32;
    let magnitude = decimal - 1;
    let formatted = if (-6..21).contains(&magnitude) {
        if decimal <= 0 {
            format!("0.{}{}", "0".repeat((-decimal) as usize), digits)
        } else if decimal as usize >= digits.len() {
            format!("{}{}", digits, "0".repeat(decimal as usize - digits.len()))
        } else {
            let (whole, fraction) = digits.split_at(decimal as usize);
            format!("{whole}.{fraction}")
        }
    } else {
        let (first, remaining) = digits.split_at(1);
        let fraction = if remaining.is_empty() {
            String::new()
        } else {
            format!(".{remaining}")
        };
        let sign = if magnitude >= 0 { "+" } else { "" };
        format!("{first}{fraction}e{sign}{magnitude}")
    };
    format!("{negative}{formatted}")
}

fn content_hash(value: &serde_json::Value) -> String {
    let mut canonical = String::new();
    canonical_json(value, &mut canonical);
    let mut hash: u32 = 0x811c9dc5;
    for code_unit in canonical.encode_utf16() {
        hash = (hash ^ u32::from(code_unit)).wrapping_mul(0x01000193);
    }
    format!("fnv1a32:{hash:08x}")
}

fn main() {
    tauri::Builder::default()
        .manage(SaveState::default())
        .invoke_handler(tauri::generate_handler![
            bridge_identity,
            load_slot,
            save_slot,
            delete_slot,
            list_slots
        ])
        .run(tauri::generate_context!())
        .expect("Failed to run Code Compiler Empire");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIRECTORY: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target")
                .join("slot-tests")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    NEXT_TEST_DIRECTORY.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn save(tick: u64) -> String {
        let snapshot = serde_json::json!({
            "schemaVersion": 6,
            "gameVersion": "0.0.1",
            "contentHash": "example",
            "seed": "test",
            "tick": tick,
            "tickDurationMs": 1000,
            "scaledTimeRemainder": 0,
            "nextEventSequence": 1,
            "wallClockSavedAt": 12345,
            "resources": {"core.demand": 40},
            "systemStates": {},
            "queuedCommands": [],
            "pendingEvents": [],
            "durableEvents": [],
            "importantEvents": [],
        });
        serde_json::json!({
            "format": "code-compiler-empire",
            "formatVersion": 1,
            "checksum": content_hash(&snapshot),
            "snapshot": snapshot,
        })
        .to_string()
    }

    #[test]
    fn slots_have_independent_revisions_and_reject_unrecognized_ids() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let auto = save(1);
        let manual = save(2);
        save_to_directory(&directory.0, "auto", &auto, 5, &state).unwrap();
        save_to_directory(&directory.0, "manual-1", &manual, 1, &state).unwrap();
        assert!(save_to_directory(&directory.0, "auto", &manual, 5, &state)
            .unwrap_err()
            .contains("Stale"));
        assert!(
            save_to_directory(&directory.0, "manual-1", &auto, 1, &state)
                .unwrap_err()
                .contains("Stale")
        );
        let restarted = Mutex::new(HashMap::new());
        assert_eq!(
            load_from_directory(&directory.0, "auto", false, &restarted)
                .unwrap()
                .revision,
            5
        );
        assert_eq!(
            load_from_directory(&directory.0, "manual-1", false, &restarted)
                .unwrap()
                .data,
            Some(manual)
        );
        assert!(save_to_directory(&directory.0, "auto", &auto, 5, &restarted).is_err());
        assert!(load_from_directory(&directory.0, "../auto", false, &state).is_err());
        assert!(save_to_directory(&directory.0, "AUTO", &auto, 10, &state).is_err());
        assert!(delete_from_directory(&directory.0, "manual-4", &state).is_err());
        assert_eq!(list_from_directory(&directory.0, &state).unwrap().len(), 4);
    }

    #[test]
    fn invalid_new_payload_cannot_change_primary_backup_or_revision() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let first = save(1);
        let second = save(2);
        save_to_directory(&directory.0, "auto", &first, 1, &state).unwrap();
        save_to_directory(&directory.0, "auto", &second, 2, &state).unwrap();
        let bad_checksum = save(3).replace("fnv1a32:", "invalid:");
        for invalid in ["{broken", bad_checksum.as_str()] {
            let error = save_to_directory(&directory.0, "auto", invalid, 3, &state).unwrap_err();
            assert!(error.contains("Invalid save data"), "{error}");
        }
        assert_eq!(
            fs::read_to_string(primary_path(&directory.0, "auto")).unwrap(),
            second
        );
        assert_eq!(
            fs::read_to_string(backup_path(&directory.0, "auto")).unwrap(),
            first
        );
        assert_eq!(
            load_from_directory(&directory.0, "auto", false, &state)
                .unwrap()
                .revision,
            2
        );

        let absent_directory = directory.0.join("not-created");
        assert!(
            save_to_directory(&absent_directory, "manual-1", "{}", 1, &state)
                .unwrap_err()
                .contains("Invalid save data")
        );
        assert!(!absent_directory.exists());
    }

    #[test]
    fn metadata_probe_distinguishes_missing_files_from_io_errors() {
        let directory = TestDirectory::new();
        let path = directory.0.join("present.json");
        fs::write(&path, "{}").unwrap();
        assert!(file_exists(&path).unwrap());
        assert!(!file_exists(&directory.0.join("missing.json")).unwrap());
        assert!(file_exists(Path::new("invalid\0path"))
            .unwrap_err()
            .contains("Cannot inspect"));
    }

    #[test]
    fn backup_tracks_last_valid_primary_without_copying_corruption() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let first = save(1);
        let second = save(2);
        save_to_directory(&directory.0, "manual-2", &first, 1, &state).unwrap();
        assert!(load_from_directory(&directory.0, "manual-2", true, &state)
            .unwrap()
            .data
            .is_none());
        save_to_directory(&directory.0, "manual-2", &second, 2, &state).unwrap();
        assert_eq!(
            load_from_directory(&directory.0, "manual-2", true, &state)
                .unwrap()
                .data,
            Some(first.clone())
        );
        let damaged = second.replace("fnv1a32:", "incorrect:");
        fs::write(primary_path(&directory.0, "manual-2"), &damaged).unwrap();
        assert_eq!(
            load_from_directory(&directory.0, "manual-2", false, &state)
                .unwrap()
                .data,
            Some(damaged)
        );
        save_to_directory(&directory.0, "manual-2", &save(3), 3, &state).unwrap();
        assert_eq!(
            load_from_directory(&directory.0, "manual-2", true, &state)
                .unwrap()
                .data,
            Some(first)
        );
        let slot = &list_from_directory(&directory.0, &state).unwrap()[2];
        assert!(slot.exists && slot.has_backup && !slot.legacy);
        fs::write(primary_path(&directory.0, "manual-2"), [0xff, 0xfe]).unwrap();
        assert!(load_from_directory(&directory.0, "manual-2", false, &state).is_err());
        save_to_directory(&directory.0, "manual-2", &save(4), 4, &state).unwrap();
        assert_eq!(
            load_from_directory(&directory.0, "manual-2", true, &state)
                .unwrap()
                .data,
            Some(save(1))
        );
    }

    #[test]
    fn canonical_checksum_matches_javascript_utf16_and_validates_raw_snapshots() {
        let value = serde_json::json!({"😀": 1, "\u{e000}": 2, "x": "\u{1f600}\n"});
        assert_eq!(content_hash(&value), "fnv1a32:e3583598");
        let numbers: serde_json::Value = serde_json::from_str(
            r#"{"small":1e-6,"tiny":1e-7,"big":1e21,"negativeZero":-0.0,"fraction":1.25}"#,
        )
        .unwrap();
        let mut canonical = String::new();
        canonical_json(&numbers, &mut canonical);
        assert_eq!(
            canonical,
            r#"{"big":1e+21,"fraction":1.25,"negativeZero":0,"small":0.000001,"tiny":1e-7}"#
        );
        assert!(valid_save(&save(3)));
        let snapshot = serde_json::json!({
            "schemaVersion": 1,
            "gameVersion": "0.0.1",
            "contentHash": "example",
            "seed": "test",
            "tick": 4,
            "tickDurationMs": 1000,
            "scaledTimeRemainder": 0,
            "wallClockSavedAt": 10,
            "resources": {},
            "systemStates": {},
            "queuedCommands": []
        });
        assert!(valid_save(&snapshot.to_string()));
        assert!(valid_save(
            &snapshot
                .to_string()
                .replace("\"schemaVersion\":1", "\"schemaVersion\":1.0")
        ));
        assert!(!valid_save("{\"schemaVersion\":5}"));
        assert!(!valid_save(&snapshot.to_string().replace(
            "\"queuedCommands\":[]",
            "\"queuedCommands\":\"invalid\""
        )));
        assert!(!valid_save(
            &save(3).replace("\"formatVersion\":1", "\"formatVersion\":2")
        ));
        assert!(!valid_save(&save(3).replace("fnv1a32:", "wrong:")));
        assert!(!valid_save(&snapshot.to_string().replace(
            "\"resources\":{}",
            "\"resources\":{\"money\":\"invalid\"}"
        )));
    }

    #[test]
    fn schema_six_saves_are_accepted_and_legacy_five_remains_loadable() {
        assert!(valid_save(&save(1)));
        let mut legacy: serde_json::Value = serde_json::from_str(&save(1)).unwrap();
        legacy["snapshot"]["schemaVersion"] = serde_json::json!(5);
        legacy["snapshot"]["resources"]
            .as_object_mut()
            .unwrap()
            .remove("core.demand");
        legacy["checksum"] = serde_json::json!(content_hash(&legacy["snapshot"]));
        assert!(valid_save(&legacy.to_string()));

        let mut broken: serde_json::Value = serde_json::from_str(&save(1)).unwrap();
        broken["snapshot"]["resources"]
            .as_object_mut()
            .unwrap()
            .remove("core.demand");
        broken["checksum"] = serde_json::json!(content_hash(&broken["snapshot"]));
        assert!(!valid_save(&broken.to_string()));
    }

    #[test]
    fn deleting_auto_keeps_legacy_but_tombstones_fallback_and_backups() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let legacy = save(1);
        fs::write(directory.0.join("empire.json"), &legacy).unwrap();
        let initial = list_from_directory(&directory.0, &state).unwrap();
        assert!(initial[0].exists && initial[0].legacy);
        assert_eq!(
            load_from_directory(&directory.0, "auto", false, &state)
                .unwrap()
                .data,
            Some(legacy.clone())
        );
        save_to_directory(&directory.0, "auto", &save(2), 1, &state).unwrap();
        assert_eq!(
            load_from_directory(&directory.0, "auto", true, &state)
                .unwrap()
                .data,
            Some(legacy.clone())
        );
        save_to_directory(&directory.0, "auto", &save(3), 2, &state).unwrap();
        assert!(!list_from_directory(&directory.0, &state).unwrap()[0].legacy);
        delete_from_directory(&directory.0, "auto", &state).unwrap();
        let restarted = Mutex::new(HashMap::new());
        let listed = list_from_directory(&directory.0, &restarted).unwrap();
        assert!(!listed[0].exists && !listed[0].has_backup && !listed[0].legacy);
        assert_eq!(listed[0].revision, 3);
        assert!(load_from_directory(&directory.0, "auto", false, &restarted)
            .unwrap()
            .data
            .is_none());
        assert_eq!(
            fs::read_to_string(directory.0.join("empire.json")).unwrap(),
            legacy
        );
        assert!(save_to_directory(&directory.0, "auto", &save(4), 3, &restarted).is_err());
        save_to_directory(&directory.0, "auto", &save(4), 4, &restarted).unwrap();
        assert!(list_from_directory(&directory.0, &restarted).unwrap()[0].exists);
        delete_from_directory(&directory.0, "auto", &restarted).unwrap();
        assert!(!list_from_directory(&directory.0, &restarted).unwrap()[0].exists);
        save_to_directory(&directory.0, "auto", &save(5), 6, &restarted).unwrap();
        assert!(
            load_from_directory(&directory.0, "auto", true, &restarted)
                .unwrap()
                .data
                .is_none(),
            "a deleted legacy save cannot become a backup on the next first save"
        );
    }

    #[test]
    fn malformed_primary_and_legacy_cannot_replace_good_backup() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let first = save(1);
        fs::write(directory.0.join("empire.json"), &first).unwrap();
        save_to_directory(&directory.0, "auto", &save(2), 1, &state).unwrap();
        assert_eq!(
            fs::read_to_string(backup_path(&directory.0, "auto")).unwrap(),
            first
        );

        let malformed = save(2).replace("fnv1a32:", "wrong:");
        fs::write(primary_path(&directory.0, "auto"), &malformed).unwrap();
        save_to_directory(&directory.0, "auto", &save(3), 2, &state).unwrap();
        assert_eq!(
            fs::read_to_string(backup_path(&directory.0, "auto")).unwrap(),
            first,
            "a corrupt modern save must not fall back to legacy as a backup source"
        );
        fs::remove_file(primary_path(&directory.0, "auto")).unwrap();
        fs::write(directory.0.join("empire.json"), b"{truncated").unwrap();
        save_to_directory(&directory.0, "auto", &save(4), 3, &state).unwrap();
        assert_eq!(
            fs::read_to_string(backup_path(&directory.0, "auto")).unwrap(),
            first,
            "a corrupt legacy save must not replace the last good backup"
        );
    }

    #[test]
    fn temp_collision_and_move_failure_preserve_primary_and_clean_up() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let first = save(1);
        save_to_directory(&directory.0, "manual-3", &first, 1, &state).unwrap();
        let path = primary_path(&directory.0, "manual-3");
        let temp = path.with_file_name(format!(
            "{}.{}.2.tmp",
            path.file_name().unwrap().to_string_lossy(),
            std::process::id()
        ));
        fs::write(&temp, "occupied").unwrap();
        let error = save_to_directory(&directory.0, "manual-3", &save(2), 2, &state).unwrap_err();
        assert!(error.contains("Cannot create temporary save"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
        assert_eq!(fs::read_to_string(&temp).unwrap(), "occupied");
        fs::remove_file(temp).unwrap();
        assert_eq!(
            load_from_directory(&directory.0, "manual-3", false, &state)
                .unwrap()
                .revision,
            2
        );
        let blocked = directory.0.join("blocked.json");
        fs::create_dir(&blocked).unwrap();
        let error = atomic_write(&blocked, b"not installed", 9).unwrap_err();
        assert!(error.contains("Cannot atomically replace"), "{error}");
        let temp = directory
            .0
            .join(format!("blocked.json.{}.9.tmp", std::process::id()));
        assert!(!temp.exists());
    }

    #[test]
    fn backup_failure_prevents_primary_replacement() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let first = save(1);
        save_to_directory(&directory.0, "manual-1", &first, 1, &state).unwrap();
        let backup = backup_path(&directory.0, "manual-1");
        let occupied = backup.with_file_name(format!(
            "{}.{}.2.tmp",
            backup.file_name().unwrap().to_string_lossy(),
            std::process::id()
        ));
        fs::write(&occupied, "occupied").unwrap();
        assert!(
            save_to_directory(&directory.0, "manual-1", &save(2), 2, &state)
                .unwrap_err()
                .contains("Cannot create temporary save")
        );
        assert_eq!(
            fs::read_to_string(primary_path(&directory.0, "manual-1")).unwrap(),
            first
        );
        assert_eq!(
            load_from_directory(&directory.0, "manual-1", false, &state)
                .unwrap()
                .revision,
            1
        );
        fs::remove_file(occupied).unwrap();
    }

    #[test]
    fn replacing_primary_is_atomic_and_removes_temporary_file() {
        let directory = TestDirectory::new();
        let state = Mutex::new(HashMap::new());
        let first = save(1);
        let second = save(2);
        save_to_directory(&directory.0, "auto", &first, 1, &state).unwrap();
        let path = primary_path(&directory.0, "auto");
        assert_eq!(fs::read_to_string(&path).unwrap(), first);
        save_to_directory(&directory.0, "auto", &second, 2, &state).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), second);
        assert_eq!(
            fs::read_to_string(backup_path(&directory.0, "auto")).unwrap(),
            first
        );
        assert!(!path
            .with_file_name(format!("empire-auto.json.{}.2.tmp", std::process::id()))
            .exists());
    }
}
