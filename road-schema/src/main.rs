use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};
use mapshow_road_schema::{write_pmtiles_streaming, write_xyz_streaming};

#[derive(Debug, Parser)]
#[command(name = "mapshow-roadgen")]
#[command(about = "Mapshow simulation-road preprocessing in Rust")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Build static XYZ Mapbox Vector Tiles plus tilejson.json using disk-backed scratch state.
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
    /// Build a single-file PMTiles v3 archive using disk-backed scratch state.
    BuildPmtiles {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

fn build_xyz(input: PathBuf, output_dir: PathBuf, tile_url_template: String) -> Result<()> {
    let summary = write_xyz_streaming(&input, &output_dir, &tile_url_template)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn build_pmtiles(input: PathBuf, output: PathBuf) -> Result<()> {
    let summary = write_pmtiles_streaming(&input, &output)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::BuildXyz {
            input,
            output_dir,
            tile_url_template,
        } => build_xyz(input, output_dir, tile_url_template),
        Command::BuildPmtiles { input, output } => build_pmtiles(input, output),
    }
}
