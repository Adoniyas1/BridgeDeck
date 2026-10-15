function y = normpdf(x, mu, sigma)
  % BridgeDeck fill-in for normpdf (Statistics package): the normal distribution's density.
  if nargin < 2, mu = 0; end
  if nargin < 3, sigma = 1; end
  y = exp(-0.5 * ((x - mu) ./ sigma) .^ 2) ./ (sqrt(2 * pi) .* sigma);
end
