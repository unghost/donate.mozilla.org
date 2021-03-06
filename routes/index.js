var signup = require('./signup');
var stripe = require('./stripe');
var paypal = require('./paypal');
var boom = require('boom');
var amountModifier = require('../scripts/amount-modifier');

var routes = {
  'signup': function(request, reply) {
    var transaction = request.payload;
    signup(transaction, function(err) {
      if (err) {
        return reply(boom.wrap(err, 500, 'Unable to complete Basket signup'));
      }

      reply().code(204);
    });
  },
  'stripe': function(request, reply) {
    var transaction = request.payload || {};
    var currency = transaction.currency;
    var amount = amountModifier.stripe(transaction.amount, currency);
    var metadata = {
      email: transaction.email,
      locale: transaction.locale
    };
    var request_id = request.headers['x-request-id'];

    stripe.customer({
      metadata,
      email: transaction.email,
      stripeToken: transaction.stripeToken
    }, function(err, customerData) {
      var stripe_customer_create_service = customerData.stripe_customer_create_service;
      var customer;
      var badRequest;
      if (err) {
        badRequest = boom.badRequest('Stripe charge failed');
        badRequest.output.payload.stripe = {
          code: err.code,
          rawType: err.rawType
        };

        request.log(['error', 'stripe', 'customer'], {
          request_id,
          stripe_customer_create_service,
          code: err.code,
          type: err.type,
          param: err.param
        });

        reply(badRequest);
      } else {
        customer = customerData.customer;
        request.log(['stripe', 'customer'], {
          request_id,
          stripe_customer_create_service,
          customer_id: customer.id
        });

        if (transaction.frequency !== 'monthly') {
          stripe.single({
            amount,
            currency,
            metadata,
            customer,
            description: transaction.description
          }, function(err, chargeData) {
            var stripe_charge_create_service = chargeData.stripe_charge_create_service;
            var charge;
            var badRequest;
            if (err) {
              badRequest = boom.badRequest('Stripe charge failed');
              badRequest.output.payload.stripe = {
                code: err.code,
                rawType: err.rawType
              };

              request.log(['error', 'stripe', 'single'], {
                request_id,
                stripe_charge_create_service,
                customer_id: customer.id,
                code: err.code,
                type: err.type,
                param: err.param
              });

              reply(badRequest);
            } else {
              charge = chargeData.charge;
              if (transaction.signup) {
                signup(transaction);
              }
              request.log(['stripe', 'single'], {
                request_id,
                stripe_charge_create_service,
                charge_id: charge.id
              });
              reply({
                frequency: "one-time",
                amount: charge.amount,
                currency: charge.currency,
                id: charge.id,
                signup: transaction.signup,
                country: transaction.country,
                email: transaction.email
              }).code(200);
            }
          });
        } else {
          stripe.recurring({
            // Stripe has plans with set amounts, not custom amounts.
            // So to get a custom amount we have a plan set to 1 cent, and we supply the quantity.
            // https://support.stripe.com/questions/how-can-i-create-plans-that-dont-have-a-fixed-price
            currency,
            metadata,
            customer,
            quantity: amount,
            stripeToken: transaction.stripeToken,
            email: transaction.email
          }, function(err, subscriptionData) {
            var stripe_create_subscription_service = subscriptionData.stripe_create_subscription_service;
            var subscription;
            if (err) {
              request.log(['error', 'stripe', 'recurring'], {
                request_id,
                stripe_create_subscription_service,
                customer_id: customer.id,
                code: err.code,
                type: err.type,
                param: err.param
              });
              reply(boom.create(400, 'Stripe subscription failed', {
                code: err.code,
                rawType: err.rawType
              }));
            } else {
              subscription = subscriptionData.subscription;
              if (transaction.signup) {
                signup(transaction);
              }
              request.log(['stripe', 'recurring'], {
                request_id,
                stripe_create_subscription_service,
                customer_id: customer.id
              });
              reply({
                frequency: "monthly",
                currency: subscription.plan.currency,
                quantity: subscription.quantity,
                id: subscription.id,
                signup: transaction.signup,
                country: transaction.country,
                email: transaction.email
              }).code(200);
            }
          });
        }
      }
    });
  },
  'paypal': function(request, reply) {
    var transaction = request.payload || {};
    var frequency = transaction.frequency || "";
    var currency = transaction.currency;
    var amount = amountModifier.paypal(transaction.amount, currency);
    var details = {
      amount: amount,
      currency: currency,
      locale: transaction.locale,
      item_name: transaction.description,
      cancelUrl: request.server.info.uri + '/',
      returnUrl: request.server.info.uri + '/api/paypal-redirect/' + frequency + '/' + transaction.locale + '/'
    };
    var request_id = request.headers['x-request-id'];
    var logTags = ['paypal', 'sale'];
    function callback(err, data) {
      var paypal_request_sale_service = data.paypal_request_sale_service;
      var tags = logTags.slice();
      tags.push(frequency === 'monthly' ? 'recurring' : 'single');
      if (err) {
        tags.push('error');
        request.log(tags, {
          request_id,
          paypal_request_sale_service,
          // https://developer.paypal.com/docs/api/#errors
          error_name: data.response.name,
          error_message: data.response.message,
          details: data.response.details
        });
        reply(boom.wrap(err, 500, 'Paypal donation failed'));
      } else {
        request.log(tags, {
          request_id,
          paypal_request_sale_service
        });
        reply({
          endpoint: process.env.PAYPAL_ENDPOINT,
          token: data.response.TOKEN
        }).code(200);
      }
    }
    if (frequency !== 'monthly') {
      paypal.setupSingle(details, callback);
    } else {
      paypal.setupRecurring(details, callback);
    }
  },
  'paypal-redirect': function(request, reply) {
    var locale = request.params.locale || '';
    if (locale) {
      locale = '/' + locale;
    }
    var frequency = request.params.frequency || 'single';
    var request_id = request.headers['x-request-id'];
    if (frequency !== 'monthly') {
      paypal.getSingleCheckoutDetails({
        token: request.url.query.token
      }, function(err, checkoutDetails) {
        var paypal_checkout_details_service = checkoutDetails.paypal_checkout_details_service;
        if (err) {
          request.log(['error', 'paypal', 'checkout-details', frequency], {
            request_id,
            paypal_checkout_details_service,
            // https://developer.paypal.com/docs/api/#errors
            error_name: checkoutDetails.response.name,
            error_message: checkoutDetails.response.message,
            details: checkoutDetails.response.details
          });
          return reply(boom.badRequest('donation failed', err));
        }

        request.log(['paypal', 'checkout-details', frequency], {
          request_id,
          paypal_checkout_details_service
        });

        paypal.completeSingleCheckout(checkoutDetails.response, function(err, data) {
          var paypal_checkout_payment_service = data.paypal_checkout_payment_service;
          if (err) {
            request.log(['error', 'paypal', 'checkout-payment', frequency], {
              request_id,
              paypal_checkout_payment_service,
              // https://developer.paypal.com/docs/api/#errors
              error_name: data.response.name,
              error_message: data.response.message,
              details: data.response.details
            });
            return reply(boom.badRequest('donation failed', err));
          }

          request.log(['paypal', 'checkout', frequency], {
            request_id,
            paypal_checkout_payment_service
          });

          reply.redirect(`${locale}/thank-you/?frequency=${frequency}&tx=${data.txn.PAYMENTINFO_0_TRANSACTIONID}&amt=${data.txn.PAYMENTREQUEST_0_AMT}&cc=${data.txn.CURRENCYCODE}`);
        });
      });
    } else {
      paypal.getRecurringCheckoutDetails({
        token: request.url.query.token
      }, function(err, checkoutDetails) {
        var paypal_checkout_details_service = checkoutDetails.paypal_checkout_details_service;
        if (err) {
          request.log(['error', 'paypal', 'checkout-details', frequency], {
            request_id,
            paypal_checkout_details_service,
            // https://developer.paypal.com/docs/api/#errors
            error_name: checkoutDetails.response.name,
            error_message: checkoutDetails.response.message,
            details: checkoutDetails.response.details
          });
          return reply(boom.badRequest('donation failed', err));
        }

        request.log(['paypal', 'checkout-details', frequency], {
          request_id,
          paypal_checkout_details_service
        });

        paypal.completeRecurringCheckout(checkoutDetails.response, function(err, data) {
          var paypal_checkout_payment_service = data.paypal_checkout_payment_service;
          if (err) {
            request.log(['error', 'paypal', 'checkout-payment', frequency], {
              request_id,
              paypal_checkout_payment_service,
              // https://developer.paypal.com/docs/api/#errors
              error_name: data.response.name,
              error_message: data.response.message,
              details: data.response.details
            });
            return reply(boom.badRequest('donation failed', err));
          }

          request.log(['paypal', 'checkout', frequency], {
            request_id,
            paypal_checkout_payment_service
          });

          // Create unique tx id by combining PayerID and timestamp
          var stamp = Date.now() / 100;
          var txId = data.txn.PAYERID + stamp;
          reply.redirect(`${locale}/thank-you/?frequency=${frequency}&tx=${txId}&amt=${data.txn.AMT}&cc=${data.txn.CURRENCYCODE}`);
        });
      });
    }
  }
};

module.exports = routes;
