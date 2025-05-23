const { check } = require("express-validator");
const validatorMiddleware = require("../../../middlewares/validatorMiddleware");
const slugify = require("slugify");

const userModel = require("../../../models/userModel");

exports.emailVerificationCodeValidator = [
  check("emailVerificationCode")
    .notEmpty()
    .withMessage("Email verification code is required.")
    .isString()
    .withMessage("Email verification code must be of type string."),

  validatorMiddleware,
];

exports.updateMyDataValidator = [
  check("firstName")
    .optional()
    .isString()
    .withMessage("First name must be of type string.")
    .isLength({ min: 3, max: 16 })
    .withMessage("First name should be between 3 and 16 characters.")
    .custom((value, { req }) => {
      const lastName = req.body.lastName;
      if (!lastName) {
        throw new Error("Please write last name.");
      }
      return true;
    }),

  check("lastName")
    .optional()
    .isString()
    .withMessage("Last name must be of type string.")
    .isLength({ min: 2, max: 16 })
    .withMessage("Last name should be between 2 and 16 characters.")
    .custom((value, { req }) => {
      const frisrName = req.body.firstName;
      if (!frisrName) {
        throw new Error("Please write frist name.");
      }
      return true;
    })
    .custom((_, { req }) => {
      const frisrName = req.body.firstName;
      const lastName = req.body.lastName;
      req.body.slug = slugify(`${frisrName} ${lastName}`);
      return true;
    }),

  check("phoneNumber")
    .optional()
    .isString()
    .withMessage("Phone number must be of type string.")
    .isMobilePhone(["ar-MA"])
    .withMessage("Invalid phone number only accepted Morocco Phone numbers."),

    check("profileImage")
    .custom((_, { req }) => {
      if (!(req.body.profileImage === undefined)) {
        throw new Error('The field you entered for profileImage is not an Image type.');
      };
      return true;
    }),

  check("profileCoverImage")
    .custom((_, { req }) => {
      if (!(req.body.profileCoverImage === undefined)) {
        throw new Error('The field you entered for profileCoverImage is not an Image type.');
      };
      return true;
    }),

  validatorMiddleware,
];

exports.addMyAddressValidator = [
  check('country')
    .notEmpty()
    .withMessage('Country is required.')
    .isString()
    .withMessage("Country must be of type string.")
    .isLength({ min: 2 })
    .withMessage('Country name must be at least 2 characters.')
    .isLength({ max: 50 })
    .withMessage('Country name cannot exceed 50 characters.'),
  
  check('state')
    .notEmpty()
    .withMessage('State is required.')
    .isString()
    .withMessage("State must be of type string.")
    .isLength({ min: 2 })
    .withMessage('State name must be at least 2 characters.')
    .isLength({ max: 50 })
    .withMessage('State name cannot exceed 50 characters.'),
  
  check('city')
    .notEmpty()
    .withMessage('City is required.')
    .isString()
    .withMessage("City must be of type string.")
    .isLength({ min: 2 })
    .withMessage('City name must be at least 2 characters.')
    .isLength({ max: 50 })
    .withMessage('City name cannot exceed 50 characters.'),
  
  check('street')
    .notEmpty()
    .withMessage('Street address is required.')
    .isString()
    .withMessage("Street address must be of type string.")
    .isLength({ min: 5 })
    .withMessage('Street address must be at least 5 characters.')
    .isLength({ max: 100 })
    .withMessage('Street address cannot exceed 100 characters.'),
  
  check('postalCode')
    .notEmpty()
    .withMessage('Postal code is required.')
    .isString()
    .withMessage("Postal code must be of type string.")
    .matches(/^\d{4,10}$/)
    .withMessage('Postal code must be between 4 and 10 digits.'),

  validatorMiddleware,
];

exports.removeMyAddressValidator = [
    check("addressId")
    .isMongoId()
    .withMessage("Invalid address id format."),

  validatorMiddleware,
];

exports.changeMyPasswordValidator = [
  check("currentPassword")
    .notEmpty()
    .withMessage("Current password is required.")
    .isString()
    .withMessage("Current password must be of type string."),

  check("newPassword")
    .notEmpty()
    .withMessage("New password is required.")
    .isString()
    .withMessage("Naw password must be of type string.")
    .isLength({ min: 8 })
    .withMessage("New password should be at least 8 characters long."),

  check("newPasswordConfirm")
    .notEmpty()
    .withMessage("New password confirm is required.")
    .isString()
    .withMessage("New password confirm must be of type string.")
    .custom((value, { req }) => {
      if (value !== req.body.newPassword) {
        throw new Error("New password confirm dose not match new password.");
      }
      return true;
    }),

  validatorMiddleware,
];

exports.changeMyEmailValidator = [
  check("newEmail")
    .notEmpty()
    .withMessage("New email is required.")
    .isString()
    .withMessage("New email must be of type string.")
    .isEmail()
    .withMessage("Please provide a valid new email address.")
    .custom(async (val) => {
      const user = await userModel.findOne({ email: val });
      if (user) {
        throw new Error("E-mail already in user.");
      }
      return true;
    }),

  check("confirmNewEmail")
    .notEmpty()
    .withMessage("Confirm new email is required.")
    .isString()
    .withMessage("Confirm new email must be of type string.")
    .isEmail()
    .withMessage("Please provide a valid confirm new email address.")
    .custom((value, { req }) => {
      if (value !== req.body.newEmail) {
        throw new Error("Confirm new email dose not match new email.");
      }
      return true;
    }),

  check("password")
    .notEmpty()
    .withMessage("Password is required.")
    .isString()
    .withMessage("Password must be of type string."),

  validatorMiddleware,
];
