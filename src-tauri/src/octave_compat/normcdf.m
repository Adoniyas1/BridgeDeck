function p = normcdf(x, mu, sigma)
  % BridgeDeck fill-in for normcdf (Statistics package).
  if nargin < 2, mu = 0; end
  if nargin < 3, sigma = 1; end
  p = 0.5 * erfc(-(x - mu) ./ (sigma * sqrt(2)));
end
