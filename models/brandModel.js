const mongoose = require("mongoose");

const brandSchema = mongoose.Schema({
  name: {
    type: String,
    required: [true, "Brand required"],
    unique: true,
    minlength: [2, "Too short brans name"],
    maxlength: [32, "Too long brand name"],
  },
  // A and B => shoping.com/a-and-b
  slung: {
    type: String,
    lowercase: true,
  },
  image: String,
}, { timestamps: true } );

module.exports = mongoose.model("Brand", brandSchema);