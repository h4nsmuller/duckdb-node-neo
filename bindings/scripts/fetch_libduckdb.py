import os
import shutil
import tarfile
import urllib.request

# Where the duckdb-shared-libs-<suffix>.tar.gz archives are fetched from.
base_url = "https://github.com/duckdb/duckdb/releases/download/v2.0.1"

# Set to a directory holding a locally built libduckdb (the files listed by the platform script,
# e.g. duckdb.h and libduckdb.so) to build against it instead of fetching the release above.
local_dir_env_var = "DUCKDB_NODE_LIBDUCKDB_DIR"

def fetch_libduckdb(suffix, files):
  output_dir = os.path.join(os.path.dirname(__file__), "..", "libduckdb")
  if not os.path.exists(output_dir):
    os.makedirs(output_dir)

  local_dir = os.environ.get(local_dir_env_var)
  if local_dir:
    for file in files:
      print(f"copying: {file} from {local_dir}")
      shutil.copy(os.path.join(local_dir, file), os.path.join(output_dir, file))
    return

  url = f"{base_url}/duckdb-shared-libs-{suffix}.tar.gz"
  local_archive_path = os.path.join(output_dir, "libduckdb.tar.gz")
  print("fetching: " + url)
  with urllib.request.urlopen(url) as response, open(local_archive_path, "wb") as f:
    while chunk := response.read(1 << 20):
      f.write(chunk)

  with tarfile.open(local_archive_path) as tar:
    for file in files:
      print("extracting: " + file)
      if hasattr(tarfile, "data_filter"):
        tar.extract(file, output_dir, filter="data")
      else:
        tar.extract(file, output_dir)
