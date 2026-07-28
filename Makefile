# Dead Simple Tiling — build/package/install helpers
# Only dependency: glib-compile-schemas (shipped with GNOME SDK / glib2-devel)

UUID    = dstiling@kmouratidis.com
SCHEMAS = schemas/gschemas.compiled
ZIP     = $(UUID).zip
# Exact files that make up the extension. Packaging from an explicit list
# (rather than zipping "." with exclusions) guarantees dev cruft like venv/,
# .git/, build artifacts or editor swap files can never leak into the zip.
FILES   = LICENSE extension.js snap.js keybindings.js metadata.json schemas

.PHONY: all schemas clean package install

all: schemas

# Compile the GSettings schema into schemas/gschemas.compiled (required at runtime)
schemas:
	glib-compile-schemas schemas/

# Package exactly the extension files into a fresh zip. The compiled schema
# binary is excluded per GNOME convention (recompiled at install time). The old
# archive is removed first so stale contents (e.g. a previous venv/) can't
# survive via zip's default merge-into-existing behavior.
package: schemas
	rm -f $(ZIP)
	zip -r9q $(ZIP) $(FILES) -x 'schemas/gschemas.compiled'

# Install into the per-user extensions dir and compile schemas in place.
# The directory name MUST match the uuid in metadata.json.
INSTALL_DIR = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
install: schemas
	mkdir -p $(INSTALL_DIR)
	cp -r LICENSE extension.js snap.js keybindings.js metadata.json schemas $(INSTALL_DIR)/
	glib-compile-schemas $(INSTALL_DIR)/schemas/

clean:
	rm -f $(SCHEMAS) $(ZIP)
