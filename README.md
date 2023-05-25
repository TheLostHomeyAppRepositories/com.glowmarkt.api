# Homey app for Glowmarkt UK Smart Meter

The [Glowmarkt Display and CAD \(Consumer Access Display\)](https://shop.glowmarkt.com) allows you to see real time usage information from your UK smart meter. Versions are available to connect to most UK SMETS 1 and SMETS 2 meters. This app enables the Display and CAD to appear as a Smart Meter device in Homey.

You will need to download the Bright app by Hildebrand Technology Limited and create an account to get started. You must have an account before you can purchase a Display and CAD from the Glowmarkt shop. Make sure you get the right version of the device for your meter (SMETS1 or SMETS2). See here for more information: https://energyguide.org.uk/smets2-smart-meters/.

## Setting up

Once you have your device set up and working with the Bright app, you can add it to Homey. This app currently supports a single device: the Display and CAD. (In theory, you should also be able to use this to connect a Glowmarkt Zigbee CAD as well but I don't have one of those devices so have not been able to test.)

When you add the device in Homey, you will be asked to enter your Bright app credentials. This is the same username and password you use to connect in your Bright app. The pairing process will then show any 'virtual entities' connected to your account. A virtual entity broadly equates to a single metered supply so generally there should be exactly one of these. 

Once you have paired your device, you should see current power usage readings appearing right away on the device tile. The device will also appear as a Smart Meter in the energy tab in the Homey app. The smart meter measures your home's total energy usage and so Homey subtracts the power usage of all other devices it knows about from this figure and shows the difference as 'Other'. More information on this feature here: https://support.homey.app/hc/en-us/articles/360010187820-Saving-energy-with-Homey-Energy

By default, the current power usage is updated every 10s (which is approximately the frequency with which the Glowmartk CAD updates the Glowmarkt API). You can change this in the device's advanced settings to anything from 10s to 3600s (1 hour).

## Limitations

* This Homey device gets data from the Glowmarkt API so an internet connection is required to receive data. (The Glowmartk Display and CAD does also support local MQTT but this is not currently supportde by this Homey app; I may look to add this in future.)
* Currently only current power usage is supported (not historical data or gas usage).

