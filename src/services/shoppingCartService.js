const asyncHandler = require("express-async-handler");
const { Worker } = require('bullmq');
const  mongoose = require("mongoose");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const ApiError = require("../utils/apiErrore");
const productModel = require("../models/productModel");
const cartModel = require("../models/cartModel");
const {
  calculateAndUpdateCartPricing,
  filterAndUpdateCartItems,
  removeRedisBullMQJob,
  expireStripeSession,
} = require("../utils/shoppingCartUtilitiesfunctions");
const { findTheSmallestPriceInSize } = require("../utils/findTheSmallestPriceInSize");
const redisBullMQConnection = require('../config/redisBullMq');
const cartQueue = require("../redisBullMqQueues/cartQueue");

// Validate product availability
const validateProductAvailability = (product, quantity, size) => {
  if (product.sizes.length === 0) {
    if (product.quantity <= 0) {
      return `Unfortunately, this product is currently out of stock.`;
    }
    if (product.quantity < quantity) {
      return `Only ${product.quantity} item(s) are available in stock.`;
    }
    return null; // Valid product state
  } else if (product.sizes.length > 0) {
    if (!size) {
      return `Please select a product size.`;
    }
    const sizeItem = product.sizes.find(
      (item) => `${item.size}`.toLowerCase() === `${size}`.toLowerCase()
    );

    if (!sizeItem) {
      return `The size you selected is not available.`;
    }
    if (sizeItem.quantity <= 0) {
      return `Unfortunately, this product is currently out of stock.`;
    }
    if (sizeItem.quantity < quantity) {
      return `Only ${
        sizeItem.quantity
      } item(s) are available for size ${sizeItem.size.toUpperCase()}.`;
    }
    return null; // Valid product size state
  }
  return `We're sorry, but this product is not available for purchase.`; // Fallback case
};

// add Redis BullMQ job
const addRedisBullMQJob = async (cartId) => {
  const job = await cartQueue.add(
    "clearCart",
    { cartId },
    {
      delay: 30 * 60 * 1000, // 30 minutes
      removeOnComplete: true,
      removeOnFail: false,
      attempts: 10000, // Retries up to 10000 times if it fails
      backoff: { type: 'exponential', delay: 5000 } // 5-second exponential backoff
    }
  );
  return job;
};

// @desc    Add a product to the customer's shopping cart
// @route   POST /api/v1/customer/shopping-cart
// @access  Private
exports.addProductToCustomerCart = asyncHandler(async (req, res, next) => {
  // Extract productId, quantity, and size from the request body
  let { productId, quantity, size } = req.body;

  // Find the product in the database using productId
  const product = await productModel.findById(productId);

  // Check if the product exists, else return a 404 error
  if (!product) {
    return next(new ApiError(`No product for this ID: ${productId}.`, 404));
  }

  // Validate product availability
  const availabilityError = validateProductAvailability(product, quantity, size);
  if (availabilityError) {
    return next(new ApiError(availabilityError, 400));
  }

  // If no sizes are available, set size to undefined to avoid size-based handling
  if (product.sizes.length <= 0) size = undefined;

  // Determine the correct price based on the selected size (if sizes exist)
  const price = product.sizes.length > 0
    ? product.sizes.find((item) => `${item.size}`.toLowerCase() === `${size}`.toLowerCase()).price
    : product.price;

  // Start a Mongoose session to allow for transactions
  const session = await mongoose.startSession();
  session.startTransaction();

  let redisBullMQJobId;
  let stripeCheckOutSessionId;

  try {
    // Find or create the user's cart in the database
    let cart =
      (await cartModel.findOne({ user: req.user._id }).session(session)) ||
      (await cartModel.create([{ user: req.user._id, cartItems: [] }], { session }))[0];

    // Handle items of cart if products updated or deleted
    filterAndUpdateCartItems(cart);

    // Handle cases where the product has no sizes
    if (product.sizes.length === 0) {
      // Deduct the requested quantity from the total quantity of the product
      await productModel.updateOne(
        { _id: productId },
        { $inc: { quantity: -quantity } },
        { timestamps: false, session }
      );
    }
    // Handle cases where the product has sizes
    else if (product.sizes.length > 0) {
      // Deduct the requested quantity from the total quantity of the specific size of product
      const updatedSizes = product.sizes.map((item) => ({
        ...item.toObject(),
        // Decrease the quantity only for the selected size; retain the quantity for others
        quantity: item.size === size ? item.quantity - quantity : item.quantity,
      }));

      // Save the updated sizes back to the product document
      await productModel.updateOne(
        { _id: productId },
        { $set: { sizes: updatedSizes } },
        { new: true, timestamps: false, session }
      );
    }

    // Check if the product is already in the cart, based on ID and size
    const productIndex = cart.cartItems.findIndex(
      (item) =>
        item.product._id.toString() === productId &&
        `${item.size}`.toLowerCase() === `${size}`.toLowerCase()
    );

    // If product exists in the cart, update its quantity, else add as a new item
    if (productIndex > -1) {
      cart.cartItems[productIndex] = {
        product: product._id,
        quantity: cart.cartItems[productIndex].quantity + quantity, // Increment quantity
        size,
        color: product.color,
        price,
      };
    } else {
      cart.cartItems.unshift({
        product: product._id,
        quantity,
        size,
        color: product.color,
        price,
      });
    }

    // Add redis bullMQ job to remove items from cart if user doesn't buy them after 30 minutes
    if (!cart.idOfRedisBullMqJob) {
      const job = await addRedisBullMQJob(cart._id.toString());

      // Add ID of Redis BullMQ job to cart
      cart.idOfRedisBullMqJob = job.id;

      // Add ID of Redis BullMQ job to redisBullMQJobId to remove job if a error occurs.
      if (cart?.idOfRedisBullMqJob) {
        redisBullMQJobId = cart?.idOfRedisBullMqJob;
      }
    }

    // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
    if (cart?.idOfStripeCheckoutSession) {
      stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
      cart.idOfStripeCheckoutSession = undefined;
    }

    // Calculate and update the total cart price
    await calculateAndUpdateCartPricing(cart, session);

  // Commit the transaction to save all changes to the database
    await session.commitTransaction();
  } catch (error) {
    // Remove Redis BullMQ job
    await removeRedisBullMQJob(redisBullMQJobId);

      // If an error occurs, abort the transaction to prevent any changes from being saved
    await session.abortTransaction();
    return next(new ApiError("Something went wrong. Please Try again.", 500));
  } finally {
    // End the session whether the transaction succeeds or fails
    session.endSession();
  }

  // Expire Stripe session if exists
  await expireStripeSession(stripeCheckOutSessionId);

  // Fetch the updated cart from the database
  cart = await cartModel.findOne({ user: req.user._id });

  // Respond with a success message, cart item count, and cart data
  res.status(200).json({
    status: "Success",
    message: "Product added to cart successfully.",
    numOfCartItems: cart.cartItems.length,
    data: cart,
  });
});

// Worker to clear customer's shopping cart if customer doesn't buy items after 30 minutes
const worker = new Worker(
  "cartQueue",
  async (job) => {
    const { cartId } = job.data;

    // Start a Mongoose session to allow for transactions
    const session = await mongoose.startSession();
    session.startTransaction();

    let stripeCheckOutSessionId;

    try {
      // Find the user's cart in the database
      let cart = await cartModel.findById(cartId).session(session);

      if (cart) {
        const storeUpdatedSizes = [];
        const bulkOps = cart.cartItems.map((cartItem) => {
          const { product, quantity, size } = cartItem;

          // Handle cases where the product has no sizes
          if (product.sizes.length === 0) {
            // Increase the product's quantity in the database to reflect the returned stock
            return {
              updateOne: {
                filter: { _id: product._id },
                update: { $inc: { quantity: quantity } },
                timestamps: false
              },
            };
          }
          // Handle cases where the product has sizes
          else if (product.sizes.length > 0) {
            // Check if the product already exists in the `storeUpdatedSizes` array
            const existingProductIndex = storeUpdatedSizes.findIndex(
              (stored) => stored.id === product._id.toString()
            );

            let updatedSizes;

            if (existingProductIndex !== -1) {
              // If the product is already in `storeUpdatedSizes`, update the sizes array by adjusting the quantity for the matching size
              updatedSizes = storeUpdatedSizes[existingProductIndex].sizes.map(
                (item) => ({
                  ...item,
                  quantity: item.size === size ? item.quantity + quantity : item.quantity,
                })
              );

              // Update the sizes in the `storeUpdatedSizes` array
              storeUpdatedSizes[existingProductIndex].sizes = updatedSizes;
            } else {
              // If the product is not in `storeUpdatedSizes`, create an updated sizes array from the original product sizes
              updatedSizes = product.sizes.map((item) => ({
                ...item.toObject(),
                quantity: item.size === size ? item.quantity + quantity : item.quantity,
              }));

              // Add the product with its updated sizes to `storeUpdatedSizes`
              storeUpdatedSizes.push({
                id: product._id.toString(),
                sizes: updatedSizes,
              });
            }

            // Find the size with the smallest price from the updated sizes
            const theSmallestPriceSize = findTheSmallestPriceInSize(updatedSizes);

            return {
              updateOne: {
                filter: { _id: product._id },
                update: {
                  $set: { sizes: updatedSizes },
                  price: theSmallestPriceSize.price ?? "",
                  priceBeforeDiscount: theSmallestPriceSize.priceBeforeDiscount ?? "",
                  discountPercent: theSmallestPriceSize.discountPercent ?? "",
                  size: theSmallestPriceSize.size ?? "",
                  quantity: theSmallestPriceSize.quantity ?? "",
                },
                timestamps: false
              },
            };
          }
        });

        // Execute bulkWrite operations to update products
        await productModel.bulkWrite(bulkOps, { session });

        // Clear all items from the cart
        cart.cartItems = [];

        // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
        if (cart?.idOfStripeCheckoutSession) {
          stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
        }

        // Recalculate the total cart price after updates
        await calculateAndUpdateCartPricing(cart, session);

        // Commit the transaction to save all changes to the database
        await session.commitTransaction();
      }
    } catch (error) {
      // If an error occurs, abort the transaction to prevent any changes from being saved
      await session.abortTransaction();
      return next(new ApiError("Something went wrong. Please Try again.", 500));
    } finally {
      // End the session whether the transaction succeeds or fails
      session.endSession();
    }

    // Expire Stripe session if exists
    await expireStripeSession(stripeCheckOutSessionId);
  },
  { connection: redisBullMQConnection }
);

// Check jobs completed or failed
worker
  .on("completed", (job) => {    
    console.log(`Clear cart job ${job.id} completed!`);
  })
  .on("failed", (job, err) => {
    console.error(`Clear cart job ${job.id} failed with error: ${err.message}`);
  });

// @desc    Retrieve the current customer's shopping cart
// @route   GET /api/v1/customer/shopping-cart
// @access  Private
exports.getCustomerCart = asyncHandler(async (req, res) => {
  // Find the user's cart
  let cart = await cartModel.findOne({ user: req.user._id });

  let stripeCheckOutSessionId;

  if (cart) {
    // Handle items of cart if products updated or deleted
    filterAndUpdateCartItems(cart);

    // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
    if (cart?.idOfStripeCheckoutSession) {
      stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
      cart.idOfStripeCheckoutSession = undefined;
    }

    // Calculate total cart price if cart exists
    await calculateAndUpdateCartPricing(cart);
  } else {
    // If no cart exists, create an empty one for the user
    cart = await cartModel.create({ user: req.user._id, cartItems: [] });
  }

  // Expire Stripe session if exists
  await expireStripeSession(stripeCheckOutSessionId);

  // Send the response with cart data
  res.status(200).json({
    status: "Success",
    message: "Cart retrieved successfully.",
    numOfCartItems: cart.cartItems.length,
    data: cart,
  });
});

// @desc    Update the quantity of a specific product in the customer's shopping cart
// @route   PUT /api/v1/customer/shopping-cart/:productId
// @access  Private
exports.updateProductQuantityInCustomerCart = asyncHandler(async (req, res, next) => {
  // Extract productId, quantity, and size from the request body
  const { productId, quantity, size } = req.body;

  // Start a Mongoose session to allow for transactions
  const session = await mongoose.startSession();
  session.startTransaction();

  let cart;
  let stripeCheckOutSessionId;

  try {
    // Find the user's cart in the database
    cart = await cartModel.findOne({ user: req.user._id }).session(session);

    if (cart) {
      // Handle items of cart if products updated or deleted
      filterAndUpdateCartItems(cart);

      // Find the index of the product in the cart using productId and size
      const productIndex = cart.cartItems.findIndex(
        (item) =>
          item.product._id.toString() === productId && item.size === size
      );

      // Check if the product exists in the cart
      if (productIndex > -1) {
        const cartItem = cart.cartItems[productIndex];

        // Handle cases where the product has no sizes
        if (cartItem.product.sizes.length === 0) {
          // Calculate the total quantity available, combining current stock with the quantity already in the cart
          const totalAvailableQuantity = cartItem.product.quantity + cartItem.quantity;

          // Check if the requested quantity exceeds the total available stock
          if (totalAvailableQuantity < quantity) {
            await session.abortTransaction(); // Abort transaction first
            await session.endSession();       // Then end session
            return next(new ApiError(`Only ${totalAvailableQuantity} item(s) are available in stock.`, 400));
          }

          // Update the product's total quantity in the database to reflect the new stock after the update
          await productModel.updateOne(
            { _id: productId },
            { $set: { quantity: totalAvailableQuantity - quantity } },
            { timestamps: false, session }
          );

          // Update the quantity of the item in the cart to match the requested quantity
          cart.cartItems[productIndex].quantity = quantity;
        }
        // Handle cases where the product has sizes
        else if (cartItem.product.sizes.length > 0) {
          // Find the specific size object that matches the user's selected size
          const productSize = cartItem.product.sizes.find(
            (item) => item.size === cartItem.size
          );

          // Calculate the total available quantity for the selected size, considering the cart's current quantity
          const totalAvailableQuantity = productSize.quantity + cartItem.quantity;

          // Check if the requested quantity exceeds the available stock for the selected size
          if (totalAvailableQuantity < quantity) {
            await session.abortTransaction(); // Abort transaction first
            await session.endSession();       // Then end session
            return next(new ApiError(`Only ${totalAvailableQuantity} item(s) are available for size ${cartItem.size.toUpperCase()}.`, 400));
          }

          // Create a new sizes array, updating only the quantity of the selected size
          const updatedSizes = cartItem.product.sizes.map((item) => ({
            ...item.toObject(),
            // Adjust the quantity for the matching size; leave others unchanged
            quantity:item.size === size ? totalAvailableQuantity - quantity : item.quantity,
          }));

          // Update the product document in the database with the modified sizes array
          await productModel.updateOne(
            { _id: productId },
            { $set: { sizes: updatedSizes } },
            { new: true, timestamps: false, session }
          );

          // Update the quantity of the item in the cart to match the requested quantity
          cart.cartItems[productIndex].quantity = quantity;
        }
      }

      // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
      if (cart?.idOfStripeCheckoutSession) {
        stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
        cart.idOfStripeCheckoutSession = undefined;
      }

      // Recalculate the total cart price after updates
      await calculateAndUpdateCartPricing(cart, session);

      // Commit the transaction to save all changes to the database
      await session.commitTransaction();
    }
  } catch (error) {
    // If an error occurs, abort the transaction to prevent any changes from being saved
    await session.abortTransaction();
    return next(new ApiError("Something went wrong. Please Try again.", 500));
  } finally {
    // End the session whether the transaction succeeds or fails
    session.endSession();
  }

  // Expire Stripe session if exists
  await expireStripeSession(stripeCheckOutSessionId);

  if (cart) {
    // Fetch the updated cart from the database
    cart = await cartModel.findOne({ user: req.user._id });
  } else {
    // If no cart exists, create a new cart for the user
    cart = await cartModel.create({ user: req.user._id, cartItems: [] });
  }

  // Respond with a success message, cart item count, and updated cart data
  res.status(200).json({
    status: "Success",
    message: "Product quantity updated successfully.",
    numOfCartItems: cart.cartItems.length,
    data: cart,
  });
});

// @desc    Remove a specific product from the customer's shopping cart
// @route   DELETE /api/v1/customer/shopping-cart/:productId
// @access  Private
exports.removeProductFromCustomerCart = asyncHandler(async (req, res, next) => {
  // Extract productId, and size from the request body
  const { productId, size } = req.body;

  // Start a Mongoose session to allow for transactions
  const session = await mongoose.startSession();
  session.startTransaction();

  let cart;
  let redisBullMQJobId;
  let stripeCheckOutSessionId;

  try {
    // Find the user's cart in the database
    cart = await cartModel.findOne({ user: req.user._id }).session(session);

    if (cart) {
      // Handle items of cart if products updated or deleted
      filterAndUpdateCartItems(cart);

      // Find the index of the product in the cart using productId and size
      const productIndex = cart.cartItems.findIndex(
        (item) => item.product._id.toString() === productId && item.size === size
      );

      // Check if the product exists in the cart
      if (productIndex > -1) {
        const cartItem = cart.cartItems[productIndex];

        // Handle cases where the product has no sizes
        if (cartItem.product.sizes.length === 0) {
          // Increase the product's quantity in the database to reflect the returned stock
          await productModel.updateOne(
            { _id: productId },
            { $inc: { quantity: cartItem.quantity } },
            { timestamps: false, session }
          );

          // Remove the product from the cart after updating the stock
          cart.cartItems.splice(productIndex, 1);
        }
        // Handle cases where the product has sizes
        else if (cartItem.product.sizes.length > 0) {
          // Create a new sizes array, updating the quantity for the specific size returned to stock
          const updatedSizes = cartItem.product.sizes.map((item) => ({
            ...item.toObject(),
            // Increase the quantity only for the size matching the cart item; keep others unchanged
            quantity: item.size === size ? item.quantity + cartItem.quantity : item.quantity,
          }));

          // Update the product document in the database with the modified sizes array
          await productModel.updateOne(
            { _id: productId },
            { $set: { sizes: updatedSizes } },
            { new: true, timestamps: false, session }
          );

          // Remove the product from the cart after updating the stock for the specific size
          cart.cartItems.splice(productIndex, 1);
        }
      }

      // Add ID of Redis BullMQ job to redisBullMQJobId to remove job later
      if (cart.cartItems.length === 0 && cart?.idOfRedisBullMqJob) {
        redisBullMQJobId = cart.idOfRedisBullMqJob;
      }

      // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
      if (cart?.idOfStripeCheckoutSession) {
        stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
        cart.idOfStripeCheckoutSession = undefined;
      }

      // Recalculate the total cart price after updates
      await calculateAndUpdateCartPricing(cart, session);

      // Commit the transaction to save all changes to the database
      await session.commitTransaction();
    }
  } catch (error) {
    // If an error occurs, abort the transaction to prevent any changes from being saved
    await session.abortTransaction();
    return next(new ApiError("Something went wrong. Please Try again.", 500));
  } finally {
    // End the session whether the transaction succeeds or fails
    session.endSession();
  }

  // Remove Redis BullMQ job
  await removeRedisBullMQJob(redisBullMQJobId);

  // Expire Stripe session if exists
  await expireStripeSession(stripeCheckOutSessionId);

  if (cart) {
    // Fetch the updated cart from the database
    cart = await cartModel.findOne({ user: req.user._id });
  } else {
    // If no cart exists, create a new cart for the user
    cart = await cartModel.create({ user: req.user._id, cartItems: [] });
  }

  // Respond with a success message, cart item count, and updated cart data
  res.status(200).json({
    status: "Success",
    message: "Product removed from cart successfully.",
    numOfCartItems: cart.cartItems.length,
    data: cart,
  });
});

// @desc    Clear all items from the customer's shopping cart
// @route   DELETE /api/v1/customer/shopping-cart/clearcartitems
// @access  Private
exports.clearCustomerCart = asyncHandler(async (req, res, next) => {
  // Start a Mongoose session to allow for transactions
  const session = await mongoose.startSession();
  session.startTransaction();

  let cart;
  let redisBullMQJobId;
  let stripeCheckOutSessionId;

  try {
    // Find the user's cart in the database
    cart = await cartModel.findOne({ user: req.user._id }).session(session);

    if (cart) {
      const storeUpdatedSizes = [];
      const bulkOps = cart.cartItems.map((cartItem) => {
        const { product, quantity, size } = cartItem;

        // Handle cases where the product has no sizes
        if (product.sizes.length === 0) {
          // Increase the product's quantity in the database to reflect the returned stock
          return {
            updateOne: {
              filter: { _id: product._id },
              update: { $inc: { quantity: quantity } },
              timestamps: false
            },
          };
        }
        // Handle cases where the product has sizes
        else if (product.sizes.length > 0) {
          // Check if the product already exists in the `storeUpdatedSizes` array
          const existingProductIndex = storeUpdatedSizes.findIndex(
            (stored) => stored.id === product._id.toString()
          );

          let updatedSizes;

          if (existingProductIndex !== -1) {
            // If the product is already in `storeUpdatedSizes`, update the sizes array by adjusting the quantity for the matching size
            updatedSizes = storeUpdatedSizes[existingProductIndex].sizes.map(
              (item) => ({
                ...item,
                quantity: item.size === size ? item.quantity + quantity : item.quantity,
              })
            );

            // Update the sizes in the `storeUpdatedSizes` array
            storeUpdatedSizes[existingProductIndex].sizes = updatedSizes;
          } else {
            // If the product is not in `storeUpdatedSizes`, create an updated sizes array from the original product sizes
            updatedSizes = product.sizes.map((item) => ({
              ...item.toObject(),
              quantity: item.size === size ? item.quantity + quantity : item.quantity,
            }));

            // Add the product with its updated sizes to `storeUpdatedSizes`
            storeUpdatedSizes.push({
              id: product._id.toString(),
              sizes: updatedSizes,
            });
          }

          // Find the size with the smallest price from the updated sizes
          const theSmallestPriceSize = findTheSmallestPriceInSize(updatedSizes);

          return {
            updateOne: {
              filter: { _id: product._id },
              update: {
                $set: { sizes: updatedSizes },
                price: theSmallestPriceSize.price ?? "",
                priceBeforeDiscount: theSmallestPriceSize.priceBeforeDiscount ?? "",
                discountPercent: theSmallestPriceSize.discountPercent ?? "",
                size: theSmallestPriceSize.size ?? "",
                quantity: theSmallestPriceSize.quantity ?? "",
              },
              timestamps: false
            },
          };
        }
      });

      // Execute bulkWrite operations to update products
      await productModel.bulkWrite(bulkOps, { session });

      // Clear all items from the cart
      cart.cartItems = [];

      // Add ID of Redis BullMQ job to redisBullMQJobId to remove job later
      if (cart?.idOfRedisBullMqJob) {
        redisBullMQJobId = cart.idOfRedisBullMqJob;
      }

      // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
      if (cart?.idOfStripeCheckoutSession) {
        stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
      }

      // Recalculate the total cart price after updates
      await calculateAndUpdateCartPricing(cart, session);

      // Commit the transaction to save all changes to the database
      await session.commitTransaction();
    }
  } catch (error) {
    // If an error occurs, abort the transaction to prevent any changes from being saved
    await session.abortTransaction();
    return next(new ApiError("Something went wrong. Please Try again.", 500));
  } finally {
    // End the session whether the transaction succeeds or fails
    session.endSession();
  }

  // Remove Redis BullMQ job
  await removeRedisBullMQJob(redisBullMQJobId);

  // Expire Stripe session if exists
  await expireStripeSession(stripeCheckOutSessionId);

  if (!cart) {
    // If no cart exists, create a new cart for the user
    cart = await cartModel.create({ user: req.user._id, cartItems: [] });
  }

  // Respond with a success message and updated cart data
  res.status(200).json({
    status: "Success",
    message: "All items cleared from cart successfully.",
    numOfCartItems: 0,
    data: cart,
  });
});

// @desc    Apply a discount coupon to the customer's shopping cart
// @route   PUT /api/v1/customer/shopping-cart/applycoupon
// @access  Private
exports.applyCouponToCustomerCart = asyncHandler(async (req, res) => {
  const { couponCode } = req.body;

  // Check if the coupon exists and is still valid
  const promotions = await stripe.promotionCodes.list({ limit: 100 });
  const coupon = promotions.data.find(c => c.code === couponCode && c.active === true);

  // Retrieve the user's cart
  let cart = await cartModel.findOne({ user: req.user._id });

  let stripeCheckOutSessionId;

  if (cart) {
    // Handle items of cart if products updated or deleted
    filterAndUpdateCartItems(cart);

    // Add coupon details to cart
    if (cart.cartItems.length > 0 && coupon) {
      cart.coupon = {
        couponId: coupon.id,
        couponCode: coupon.code,
        couponDiscount: coupon.coupon.percent_off,
      }
    }

    // Add Stripe checkout session ID to atripeCheckOutSessionId to expire session later
    if (cart?.idOfStripeCheckoutSession) {
      stripeCheckOutSessionId = cart.idOfStripeCheckoutSession;
      cart.idOfStripeCheckoutSession = undefined;
    }

    // Calculate the current total price of the cart
    await calculateAndUpdateCartPricing(cart);
  } else {
    // If no cart exists, create a new cart for the user
    cart = await cartModel.create({ user: req.user._id, cartItems: [] });
  }

  // Expire Stripe session if exists
  await expireStripeSession(stripeCheckOutSessionId);

  // Send the response with the updated cart information
  res.status(200).json({
    status: "Success",
    message: "Price discount applied successfully",
    numOfCartItems: cart.cartItems.length,
    data: cart,
  });
});
