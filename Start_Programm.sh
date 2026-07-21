#!/bin/bash
# Wechselt in das Verzeichnis, in dem sich dieses Skript befindet
cd "$(dirname "$0")"

echo "============================================="
echo "  LN-Markets Test Trading Server wird gestartet..."
echo "============================================="
echo ""

# Öffnet den Standardbrowser nach 1.5 Sekunden Verzögerung
(sleep 1.5 && firefox http://localhost:3000) &

# Startet den Node-Server
node server.js

echo ""
echo "============================================="
echo "  Der Server wurde beendet."
echo "============================================="
read -p "Drücke ENTER, um dieses Fenster zu schließen..."
