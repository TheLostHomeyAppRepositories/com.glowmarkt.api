'use strict';

const { Driver } = require('homey');

class MyDriver extends Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device
   * and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPairListDevices() {
    return [
      {
        name: 'Smart Meter',
        data: {
          id: 'my-smart-meter',
        },
        store: {
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbkhhc2giOiJiZmVjMzc3ZTVlYzMwYmNmMmJjNGMzZGMyOGU3ZjIyZmUzNzdiNTIxOWMzMzc4YWY4YmQ5MzFhMmQ2OWE3ODdlODQyNmQ4MTFjYjc1NzcyZGQ5OGM0ZTU4ZDgzODNiODkiLCJ2ZXJzaW9uIjoiMS4xIiwiaWF0IjoxNjY3NTIwMDAwLCJleHAiOjE3MTUwNDAwMDB9.KjcQdzyGRdVhJzpWMGKVNHeBhhFwoYTh75zzZ75oarU',
        },
      },
    ];
  }

}

module.exports = MyDriver;
