The Glowmarkt Display and CAD (Consumer Access Display) shows real-time usage and tariff information from your UK smart meter. This app brings those readings into Homey in two ways.

Display and CAD (API) reads your electricity usage from the Glowmarkt cloud. Add it with your Bright app login. It shows current power, the imported energy total and your tariff, and appears in Homey Energy as a whole-home meter. Readings update every 10 seconds by default.

Glow electricity meter (local) and Glow gas meter (local) read your display's local MQTT feed directly, without the internet. The app runs its own MQTT broker, or connects to one you already have. The electricity meter shows live power (negative while you export) and imported and exported energy; the gas meter shows gas in m³ for Homey Energy, and gas energy in kWh. Both show the tariff, standing charge and the display's link to your smart meter, warn when the display stops sending data, and have flow cards. They need display firmware 1.8.12 or later, and a fixed IP address for Homey.

Nothing runs for the local meters, and no network port is opened, until you add one. The app needs Homey 12.9.0 or later.
