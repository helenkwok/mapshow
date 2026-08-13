use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use mapshow_road_schema::{read_road_dataset, write_pmtiles, write_xyz_tiles};

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
    ExtractJson {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Build static XYZ Mapbox Vector Tiles plus tilejson.json.
    BuildXyz {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output_dir: PathBuf,
        #[arg(
            long,
            default_value = "http://localhost:8080/game-roads/{z}/{x}/{y}.pbf"
        )]
        tile_url_template: String,
    },
    /// Build a single-file PMTiles v3 archive containing MVT game-road tiles.
    BuildPmtiles {
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
    let file = File::create(&output).with_context(|| format!("creating {}", output.display()))?;
    let mut writer = BufWriter::new(file);

    for segment in &dataset.segments {
        serde_json::to_writer(&mut writer, segment)?;
        writer.write_all(b"\n")?;
    }
    writer.flush()?;

    eprintln!("{}", serde_json::to_string_pretty(&dataset.summary)?);
    Ok(())
}

fn build_xyz(input: PathBuf, output_dir: PathBuf, tile_url_template: String) -> Result<()> {
    let dataset = read_road_dataset(&input)?;
    let summary = write_xyz_tiles(&dataset, &output_dir, &tile_url_template)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn build_pmtiles(input: PathBuf, output: PathBuf) -> Result<()> {
    let dataset = read_road_dataset(&input)?;
    let summary = write_pmtiles(&dataset, &output)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Inspect { input } => inspect(input),
        Command::ExtractJson { input, output } => extract_json(input, output),
        Command::BuildXyz {
            input,
            output_dir,
            tile_url_template,
        } => build_xyz(input, output_dir, tile_url_template),
        Command::BuildPmtiles { input, output } => build_pmtiles(input, output),
    }
}
