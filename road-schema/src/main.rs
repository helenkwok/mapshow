use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use mapshow_road_schema::read_road_dataset;

#[derive(Debug, Parser)]
#[command(name = "mapshow-roadgen")]
#[command(about = "Mapshow simulation-road preprocessing in Rust")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Read an OSM PBF and report game-road/topology extraction statistics.
    Inspect {
        #[arg(long)]
        input: PathBuf,
    },
    /// Emit intersection-split schema-v3 road segments as newline-delimited JSON.
    /// This is a migration/debug format; the final production output will be MVT/PMTiles.
    ExtractJson {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

fn inspect(input: PathBuf) -> Result<()> {
    let dataset = read_road_dataset(&input)?;
    println!("{}", serde_json::to_string_pretty(&dataset.summary)?);
    Ok(())
}

fn extract_json(input: PathBuf, output: PathBuf) -> Result<()> {
    let dataset = read_road_dataset(&input)?;
    let file = File::create(&output)
        .with_context(|| format!("creating {}", output.display()))?;
    let mut writer = BufWriter::new(file);

    for segment in &dataset.segments {
        serde_json::to_writer(&mut writer, segment)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()?;

    eprintln!("{}", serde_json::to_string_pretty(&dataset.summary)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Inspect { input } => inspect(input),
        Command::ExtractJson { input, output } => extract_json(input, output),
    }
}
