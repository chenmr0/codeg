"""Call a running local CodeGraph service through a standard MCP stdio proxy.

Install the Python MCP SDK: python -m pip install mcp
Start the service first: codegraph service start --path /absolute/project
Run: python shared_mcp_client.py /absolute/project
"""
import argparse
import asyncio
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main(project: Path, command: str) -> None:
    project = project.expanduser().resolve(strict=True)
    if not project.is_dir():
        raise ValueError(f"Not a directory: {project}")
    parameters = StdioServerParameters(
        command=command,
        args=["serve", "--mcp", "--path", str(project), "--shared-required"],
    )
    # Each script owns a lightweight proxy and an independent MCP session.
    # The persistent daemon is shared with the Agent and survives this block.
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("status", {})
            if result.isError:
                raise RuntimeError(result.model_dump_json())
            print(result.model_dump_json(indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("--command", default="codegraph", help="CodeGraph executable path")
    arguments = parser.parse_args()
    asyncio.run(main(arguments.project, arguments.command))
